import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentView,
  Harness,
  McpOAuthCallbackResponse,
  McpOAuthStartResponse,
  McpServerView,
  ServerEvent,
} from "@vibe-center/shared";
import { MCP_OAUTH_REDIRECT_PATH } from "@vibe-center/shared";
import { secureUrl } from "../src/mcp/oauth.ts";
import { type AppServer, createServer } from "../src/server.ts";
import { type OAuthTestServer, startOAuthMcpServer } from "./fixtures/oauth-mcp-server.ts";

const FAKE_AGENT = join(import.meta.dir, "fake-agent.ts");

let app: AppServer;
let base: string;
let as: OAuthTestServer;
let dataDir: string;
let agent: AgentView;
/** Two signed-in devices. */
let phone = "";
let laptop = "";
const events: ServerEvent[] = [];

async function signIn(): Promise<string> {
  const res = await fetch(`${base}/api/auth/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: app.services.auth.mintLinkToken() }),
  });
  return res.headers.get("set-cookie")!.split(";")[0]!;
}

async function raw(path: string, init: { method?: string; json?: unknown; cookie?: string } = {}) {
  return fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers: {
      cookie: init.cookie ?? laptop,
      origin: base,
      ...(init.json !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
  });
}

async function api<T>(
  path: string,
  init: { method?: string; json?: unknown; cookie?: string } = {},
): Promise<T> {
  const res = await raw(path, init);
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${res.status} ${await res.text()}`);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

async function until<T>(
  fn: () => T | undefined | null | false | Promise<T | undefined | null | false>,
  ms = 8000,
) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await Bun.sleep(25);
  }
  throw new Error("timed out");
}

const server = (id: string) => api<McpServerView>(`/api/mcp/servers/${id}`);

/** The browser's part: open the authorization URL (the test AS approves at once), read the redirect. */
async function authorize(url: string): Promise<URL> {
  const res = await fetch(url, { redirect: "manual" });
  expect(res.status).toBe(302);
  return new URL(res.headers.get("location")!);
}

/** What the redirect page posts. */
function callbackBody(back: URL) {
  const q = back.searchParams;
  return {
    state: q.get("state")!,
    ...(q.get("code") ? { code: q.get("code")! } : {}),
    ...(q.get("iss") ? { iss: q.get("iss")! } : {}),
    ...(q.get("error") ? { error: q.get("error")! } : {}),
  };
}

async function signInTo(id: string, cookie = laptop): Promise<McpOAuthCallbackResponse> {
  const start = await api<McpOAuthStartResponse>(`/api/mcp/servers/${id}/oauth`, {
    method: "POST",
    json: {},
    cookie,
  });
  const back = await authorize(start.authorizationUrl);
  return api<McpOAuthCallbackResponse>("/api/mcp/oauth/callback", {
    method: "POST",
    json: callbackBody(back),
    cookie,
  });
}

async function ask(text: string): Promise<string> {
  const r = await app.services.chat.prompt(agent.id, { text, source: "user" }).done;
  if (r.status !== "complete") throw new Error(`turn ${r.status}: ${r.error}`);
  return r.text;
}

const storedTokens = (id: string) =>
  app.services.repos.mcpOAuth.get<{
    tokens?: { access_token: string; refresh_token?: string; expiresAt: number };
  }>(id)?.tokens;

let secure: McpServerView;

beforeAll(async () => {
  as = startOAuthMcpServer(0);
  dataDir = mkdtempSync(join(tmpdir(), "vc-oauth-"));
  app = createServer({ dataDir, port: 0, webDist: null, timeouts: { idleMs: 10_000, cancelGraceMs: 500 } });
  base = `http://127.0.0.1:${app.port}`;
  app.services.bus.subscribe((e) => events.push(e));
  laptop = await signIn();
  phone = await signIn();
  const harness = await api<Harness>("/api/harnesses", {
    method: "POST",
    json: { name: "Fake", command: process.execPath, args: [FAKE_AGENT] },
  });
  agent = await api<AgentView>("/api/agents", {
    method: "POST",
    json: { name: "Oauthie", avatar: { emoji: "🔑", color: "#336699" }, harnessId: harness.id, cwd: dataDir },
  });
  secure = await api<McpServerView>("/api/mcp/servers", {
    method: "POST",
    json: { name: "secure", transport: "http", url: as.url },
  });
});

afterAll(async () => {
  await app.stop();
  await as.stop();
});

describe("MCP OAuth", () => {
  test("a server that answers 401 shows as needing sign-in", async () => {
    const s = await until(async () => {
      const v = await server(secure.id);
      return v.status.state === "needs_auth" && v;
    });
    expect(s.oauth).toMatchObject({ connected: false, registration: null, clientId: null });
    expect(s.tools).toEqual([]);
    // Nothing registered with the authorization server until the user starts a sign-in.
    expect(as.stats.registrations).toBe(0);
  });

  test("start: discovery, dynamic registration, and an authorization URL with PKCE, resource and state", async () => {
    const start = await api<McpOAuthStartResponse>(`/api/mcp/servers/${secure.id}/oauth`, {
      method: "POST",
      json: {},
    });
    expect(start.redirectUri).toBe(`${base}${MCP_OAUTH_REDIRECT_PATH}`);
    expect(as.stats.registrations).toBe(1);
    const u = new URL(start.authorizationUrl);
    expect(`${u.origin}${u.pathname}`).toBe(`${as.issuer}/authorize`);
    const q = Object.fromEntries(u.searchParams);
    expect(q).toMatchObject({
      response_type: "code",
      code_challenge_method: "S256",
      redirect_uri: start.redirectUri,
      resource: as.url,
    });
    expect(q.code_challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.state!.length).toBeGreaterThanOrEqual(43);
    expect(q.scope!.split(" ").sort()).toEqual(["mcp:tools", "offline_access"]);
    expect(q.client_id).toStartWith("client-");
    // A second start reuses the registration.
    await api(`/api/mcp/servers/${secure.id}/oauth`, { method: "POST", json: {} });
    expect(as.stats.registrations).toBe(1);
    expect((await server(secure.id)).oauth?.registration).toBe("dynamic");
  });

  test("a wrong state, a callback from another device, a wrong issuer and open redirects are refused", async () => {
    const start = await api<McpOAuthStartResponse>(`/api/mcp/servers/${secure.id}/oauth`, {
      method: "POST",
      json: {},
    });
    const back = await authorize(start.authorizationUrl);
    const body = callbackBody(back);

    const wrongState = await raw("/api/mcp/oauth/callback", {
      method: "POST",
      json: { ...body, state: "not-the-state" },
    });
    expect(wrongState.status).toBe(400);

    // The phone can't finish the laptop's sign-in, and the attempt burns it.
    const otherDevice = await raw("/api/mcp/oauth/callback", { method: "POST", json: body, cookie: phone });
    expect(otherDevice.status).toBe(403);
    const replay = await raw("/api/mcp/oauth/callback", { method: "POST", json: body });
    expect(replay.status).toBe(400);

    // RFC 9207: an `iss` from another authorization server is refused before the code is used.
    const s2 = await api<McpOAuthStartResponse>(`/api/mcp/servers/${secure.id}/oauth`, {
      method: "POST",
      json: {},
    });
    const b2 = callbackBody(await authorize(s2.authorizationUrl));
    const tokensBefore = as.stats.tokens;
    const badIss = await raw("/api/mcp/oauth/callback", {
      method: "POST",
      json: { ...b2, iss: "https://attacker.example" },
    });
    expect(badIss.status).toBe(400);
    // …and so is one without `iss` when the server advertises it.
    const s3 = await api<McpOAuthStartResponse>(`/api/mcp/servers/${secure.id}/oauth`, {
      method: "POST",
      json: {},
    });
    const { iss: _, ...noIss } = callbackBody(await authorize(s3.authorizationUrl));
    expect((await raw("/api/mcp/oauth/callback", { method: "POST", json: noIss })).status).toBe(400);
    expect(as.stats.tokens).toBe(tokensBefore);

    // Without a cookie, or cross-origin, nothing happens at all.
    const anon = await fetch(`${base}/api/mcp/oauth/callback`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify(body),
    });
    expect(anon.status).toBe(401);
    const cross = await fetch(`${base}/api/mcp/servers/${secure.id}/oauth`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example", cookie: laptop },
      body: "{}",
    });
    expect(cross.status).toBe(403);

    for (const returnTo of ["//evil.example/x", "https://evil.example", "/\\evil.example", "settings"]) {
      const r = await raw(`/api/mcp/servers/${secure.id}/oauth`, { method: "POST", json: { returnTo } });
      expect(r.status).toBe(400);
    }
  });

  test("sign-in: tokens are exchanged with PKCE, tools are discovered, an agent calls one", async () => {
    events.length = 0;
    const done = await signInTo(secure.id);
    expect(done).toEqual({
      serverId: secure.id,
      serverName: "secure",
      returnTo: "/settings/mcp",
      popup: false,
    });
    const s = await until(async () => {
      const v = await server(secure.id);
      return v.status.state === "connected" && v;
    });
    expect(s.tools.map((t) => t.name).sort()).toEqual(["echo", "whoami"]);
    expect(s.oauth).toMatchObject({
      connected: true,
      account: "tester@example.com",
      refreshable: true,
      issuer: as.issuer,
      registration: "dynamic",
    });
    expect(s.oauth?.grantedScopes.sort()).toEqual(["mcp:tools", "offline_access"]);
    expect(s.oauth!.expiresAt!).toBeGreaterThan(Date.now() + 3000_000);

    await api(`/api/agents/${agent.id}/tools`, {
      method: "PATCH",
      json: { serverId: secure.id, enabled: true },
    });
    expect(await ask("mcp-call secure__whoami {}")).toContain("you are tester");
  });

  test("an expired access token is refreshed, on a 401 and ahead of its expiry", async () => {
    const before = storedTokens(secure.id)!;
    as.expireAccessTokens();
    expect(await ask('mcp-call secure__echo {"text":"after expiry"}')).toContain("echo: after expiry");
    expect(as.stats.refreshes).toBe(1);
    const after = storedTokens(secure.id)!;
    expect(after.access_token).not.toBe(before.access_token);
    expect(after.refresh_token).not.toBe(before.refresh_token); // rotated

    // Known to expire soon: refreshed before the request, without a 401 first.
    const state = app.services.repos.mcpOAuth.get<Record<string, unknown>>(secure.id)!;
    app.services.repos.mcpOAuth.set(secure.id, {
      ...state,
      tokens: { ...(state.tokens as object), expiresAt: Date.now() + 1000 },
    });
    expect(await ask("mcp-call secure__whoami {}")).toContain("you are tester");
    expect(as.stats.refreshes).toBe(2);
  });

  test("tokens never appear in API responses or events", async () => {
    const t = storedTokens(secure.id)!;
    const list = await (await raw("/api/mcp/servers")).text();
    const tools = await (await raw(`/api/agents/${agent.id}/tools`)).text();
    const all = JSON.stringify(events) + list + tools;
    expect(all).not.toContain(t.access_token);
    expect(all).not.toContain(t.refresh_token!);
    expect(all).not.toContain("refresh_token");
    expect(all).not.toContain("code_verifier");
    expect(events.some((e) => e.type === "mcp.server.upsert")).toBe(true);
  });

  test("a revoked grant: the refresh fails, the server needs sign-in, the agent gets a clear error", async () => {
    as.revokeAll();
    const reply = await ask("mcp-call secure__whoami {}");
    expect(reply).toContain('The "secure" MCP server needs sign-in');
    const s = await until(async () => {
      const v = await server(secure.id);
      return v.status.state === "needs_auth" && v;
    });
    expect(s.oauth?.connected).toBe(false);
    expect(s.status.message).toContain("Sign in again");
    // The tools stay listed (the agent's switches keep their place) and work again after sign-in.
    expect(s.tools).toHaveLength(2);
    await signInTo(secure.id);
    await until(async () => (await server(secure.id)).status.state === "connected");
    expect(await ask("mcp-call secure__whoami {}")).toContain("you are tester");
  });

  test("disconnect revokes at the authorization server and forgets the tokens", async () => {
    const revocations = as.stats.revocations;
    const s = await api<McpServerView>(`/api/mcp/servers/${secure.id}/oauth`, { method: "DELETE" });
    expect(as.stats.revocations).toBeGreaterThan(revocations);
    expect(s.status.state).toBe("needs_auth");
    expect(s.oauth?.connected).toBe(false);
    expect(storedTokens(secure.id)).toBeUndefined();
    expect(await ask("mcp-call secure__whoami {}")).toContain("needs sign-in");
  });

  test("without dynamic registration: asks for a client ID, then uses the pre-registered one", async () => {
    const other = startOAuthMcpServer(0, { registration: false, iss: false });
    try {
      const v = await api<McpServerView>("/api/mcp/servers", {
        method: "POST",
        json: { name: "prereg", transport: "http", url: other.url },
      });
      const r = await raw(`/api/mcp/servers/${v.id}/oauth`, { method: "POST", json: {} });
      expect(r.status).toBe(400);
      expect(((await r.json()) as { error: string }).error).toContain(
        `redirect URI ${base}${MCP_OAUTH_REDIRECT_PATH}`,
      );

      other.addClient({
        clientId: "my-client",
        clientSecret: "my-client-secret-123456",
        redirectUris: [`${base}${MCP_OAUTH_REDIRECT_PATH}`],
      });
      const edited = await api<McpServerView>(`/api/mcp/servers/${v.id}`, {
        method: "PATCH",
        json: { oauth: { clientId: "my-client", clientSecret: "my-client-secret-123456", scopes: null } },
      });
      expect(edited.oauth).toMatchObject({ clientId: "my-client", clientSecret: { hint: "3456" } });
      expect(JSON.stringify(edited)).not.toContain("my-client-secret");
      await signInTo(v.id); // no `iss` (not advertised): accepted
      const s = await until(async () => {
        const x = await server(v.id);
        return x.status.state === "connected" && x;
      });
      expect(s.oauth?.registration).toBe("preregistered");
      expect(other.stats.registrations).toBe(0);
      // Keeping the stored secret on a later save.
      const kept = await api<McpServerView>(`/api/mcp/servers/${v.id}`, {
        method: "PATCH",
        json: { oauth: { clientId: "my-client", clientSecret: { keep: true }, scopes: "mcp:tools" } },
      });
      expect(kept.oauth).toMatchObject({ clientSecret: { hint: "3456" }, scopes: "mcp:tools" });
      await api(`/api/mcp/servers/${v.id}`, { method: "DELETE" });
    } finally {
      await other.stop();
    }
  });

  test("only https (or loopback) URLs are used for OAuth", () => {
    expect(secureUrl("https://auth.example.com/x")).toBe(true);
    expect(secureUrl("http://127.0.0.1:9/x")).toBe(true);
    expect(secureUrl("http://localhost:9/x")).toBe(true);
    expect(secureUrl("http://auth.example.com/x")).toBe(false);
    expect(secureUrl("http://localhost.evil.example/x")).toBe(false);
    expect(secureUrl("javascript:alert(1)")).toBe(false);
  });
});

#!/usr/bin/env bun
// A local MCP server protected by its own OAuth authorization server, for the OAuth tests (bun
// and e2e). It does what the MCP Authorization spec asks of both sides:
// - resource: `/mcp` (streamable HTTP, stateless) answers 401 + `WWW-Authenticate: Bearer
//   resource_metadata=…, scope=…` without a valid token; RFC 9728 metadata at
//   `/.well-known/oauth-protected-resource/mcp`
// - authorization server, issuer `<base>/auth` (path insertion: RFC 8414 metadata at
//   `/.well-known/oauth-authorization-server/auth`): dynamic registration, authorize (auto-approves,
//   checks client, exact redirect URI, PKCE S256, resource), token (code + PKCE, refresh with
//   rotation), revoke (RFC 7009), `iss` in the response (RFC 9207)
// - test controls under `/test/*`: expire access tokens, revoke everything, stats, options.
// Run directly (`bun oauth-mcp-server.ts [port]`) it prints `OAUTH_MCP_URL=<base>/mcp`.
import { createHash, randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

export interface OAuthTestOptions {
  /** Access token lifetime (seconds). */
  expiresIn: number;
  /** Advertise and send `iss` (RFC 9207). */
  iss: boolean;
  /** Offer dynamic client registration. */
  registration: boolean;
  /**
   * Like T3 Code: no refresh tokens, no revocation endpoint, no scope in the 401 challenge,
   * two scopes in the resource metadata and a `resource_name`.
   */
  t3Like: boolean;
}

interface Client {
  clientId: string;
  clientSecret?: string;
  redirectUris: string[];
}
interface Code {
  clientId: string;
  redirectUri: string;
  challenge: string;
  resource: string;
  scope: string;
  expiresAt: number;
}
interface Grant {
  clientId: string;
  scope: string;
  subject: string;
  revoked: boolean;
}

export interface OAuthTestServer {
  base: string;
  /** The MCP endpoint (the protected resource). */
  url: string;
  issuer: string;
  stats: {
    registrations: number;
    authorizations: number;
    tokens: number;
    refreshes: number;
    revocations: number;
    mcpCalls: number;
    lastAuthorize: Record<string, string> | null;
  };
  options: OAuthTestOptions;
  /** Every access token stops working (as if expired); refresh tokens still work. */
  expireAccessTokens(): void;
  /** Every grant is revoked: access and refresh tokens. */
  revokeAll(): void;
  /** Pre-register a client (for the no-registration case). */
  addClient(c: Client): void;
  stop(): Promise<void>;
}

const b64url = (b: Buffer) => b.toString("base64url");
const token = () => b64url(randomBytes(24));
const S256 = (v: string) => b64url(createHash("sha256").update(v).digest());
const SCOPE = "mcp:tools";
const T3_SCOPES = ["orchestration:read", "orchestration:operate"];

export function startOAuthMcpServer(port = 0, opts: Partial<OAuthTestOptions> = {}): OAuthTestServer {
  const options: OAuthTestOptions = {
    expiresIn: 3600,
    iss: true,
    registration: true,
    t3Like: false,
    ...opts,
  };
  const clients = new Map<string, Client>();
  const codes = new Map<string, Code>();
  const grants = new Map<string, Grant>();
  /** access token → grant id, expiry */
  const access = new Map<string, { grant: string; expiresAt: number }>();
  /** refresh token → grant id (rotated: an old one is deleted) */
  const refresh = new Map<string, string>();
  const stats: OAuthTestServer["stats"] = {
    registrations: 0,
    authorizations: 0,
    tokens: 0,
    refreshes: 0,
    revocations: 0,
    mcpCalls: 0,
    lastAuthorize: null,
  };
  let base = "";
  const issuer = () => `${base}/auth`;
  const resource = () => `${base}/mcp`;
  const json = (body: unknown, status = 200) =>
    Response.json(body, { status, headers: { "cache-control": "no-store" } });
  const oauthError = (error: string, description: string, status = 400) =>
    json({ error, error_description: description }, status);

  function issueTokens(grantId: string) {
    const g = grants.get(grantId)!;
    const at = token();
    const rt = options.t3Like ? undefined : token();
    access.set(at, { grant: grantId, expiresAt: Date.now() + options.expiresIn * 1000 });
    if (rt) refresh.set(rt, grantId);
    // An unsigned ID token, so the client can show who signed in.
    const idToken = [
      b64url(Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" }))),
      b64url(
        Buffer.from(JSON.stringify({ iss: issuer(), sub: g.subject, email: `${g.subject}@example.com` })),
      ),
      "",
    ].join(".");
    return json({
      access_token: at,
      token_type: "Bearer",
      expires_in: options.expiresIn,
      refresh_token: rt,
      scope: g.scope,
      id_token: idToken,
    });
  }

  /** Client auth at the token/revoke endpoints: none (public) or client_secret_basic/post. */
  function authClient(req: Request, form: URLSearchParams): Client | null {
    let id = form.get("client_id");
    let secret = form.get("client_secret");
    const basic = req.headers.get("authorization");
    if (basic?.startsWith("Basic ")) {
      const [u, p] = Buffer.from(basic.slice(6), "base64").toString().split(":");
      id = decodeURIComponent(u ?? "");
      secret = decodeURIComponent(p ?? "");
    }
    const c = id ? clients.get(id) : undefined;
    if (!c) return null;
    if (c.clientSecret && c.clientSecret !== secret) return null;
    return c;
  }

  function mcpServer(subject: string): McpServer {
    const server = new McpServer({ name: "oauth-test", version: "0.1.0" });
    server.registerTool("whoami", { description: "Who the token belongs to." }, () => {
      stats.mcpCalls++;
      return { content: [{ type: "text" as const, text: `you are ${subject}` }] };
    });
    server.registerTool(
      "echo",
      { description: "Echo the text back.", inputSchema: { text: z.string() } },
      ({ text }) => {
        stats.mcpCalls++;
        return { content: [{ type: "text" as const, text: `echo: ${text}` }] };
      },
    );
    return server;
  }

  const srv = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const p = url.pathname;

      // ---- protected resource ----
      if (
        p === "/.well-known/oauth-protected-resource/mcp" ||
        p === "/.well-known/oauth-protected-resource"
      ) {
        return json({
          resource: resource(),
          authorization_servers: [issuer()],
          scopes_supported: options.t3Like ? T3_SCOPES : [SCOPE],
          bearer_methods_supported: ["header"],
          ...(options.t3Like ? { resource_name: "T3 Code" } : {}),
        });
      }
      if (p === "/mcp") {
        const auth = req.headers.get("authorization");
        const at = auth?.startsWith("Bearer ") ? access.get(auth.slice(7)) : undefined;
        const grant = at ? grants.get(at.grant) : undefined;
        if (!at || !grant || grant.revoked || at.expiresAt < Date.now()) {
          const err = auth ? `, error="invalid_token"` : "";
          return new Response("unauthorized", {
            status: 401,
            headers: {
              "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"${options.t3Like ? "" : `, scope="${SCOPE}"`}${err}`,
            },
          });
        }
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        await mcpServer(grant.subject).connect(transport);
        return transport.handleRequest(req);
      }

      // ---- authorization server ----
      if (p === "/.well-known/oauth-authorization-server/auth") {
        return json({
          issuer: issuer(),
          authorization_endpoint: `${issuer()}/authorize`,
          token_endpoint: `${issuer()}/token`,
          ...(options.t3Like ? {} : { revocation_endpoint: `${issuer()}/revoke` }),
          ...(options.registration ? { registration_endpoint: `${issuer()}/register` } : {}),
          response_types_supported: ["code"],
          grant_types_supported: options.t3Like
            ? ["authorization_code"]
            : ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: options.t3Like
            ? ["none"]
            : ["none", "client_secret_basic", "client_secret_post"],
          scopes_supported: options.t3Like ? T3_SCOPES : [SCOPE, "offline_access"],
          authorization_response_iss_parameter_supported: options.iss,
        });
      }
      if (p === "/auth/register" && req.method === "POST" && options.registration) {
        const body = (await req.json()) as { redirect_uris?: string[]; client_name?: string };
        if (!body.redirect_uris?.length) return oauthError("invalid_redirect_uri", "redirect_uris required");
        const c: Client = { clientId: `client-${token()}`, redirectUris: body.redirect_uris };
        clients.set(c.clientId, c);
        stats.registrations++;
        return json(
          {
            ...body,
            client_id: c.clientId,
            client_id_issued_at: Math.floor(Date.now() / 1000),
            token_endpoint_auth_method: "none",
          },
          201,
        );
      }
      if (p === "/auth/authorize" && req.method === "GET") {
        const q = Object.fromEntries(url.searchParams);
        stats.lastAuthorize = q;
        const c = clients.get(q.client_id ?? "");
        // Errors before the redirect URI is trusted are shown here, never redirected.
        if (!c) return new Response("unknown client", { status: 400 });
        if (!q.redirect_uri || !c.redirectUris.includes(q.redirect_uri)) {
          return new Response("redirect_uri mismatch", { status: 400 });
        }
        const back = new URL(q.redirect_uri);
        if (q.state) back.searchParams.set("state", q.state);
        if (options.iss) back.searchParams.set("iss", issuer());
        const fail = (error: string) => {
          back.searchParams.set("error", error);
          return Response.redirect(back.href, 302);
        };
        if (q.response_type !== "code") return fail("unsupported_response_type");
        if (q.code_challenge_method !== "S256" || !q.code_challenge) return fail("invalid_request");
        if (q.resource !== resource()) return fail("invalid_target");
        const code = token();
        codes.set(code, {
          clientId: c.clientId,
          redirectUri: q.redirect_uri,
          challenge: q.code_challenge,
          resource: q.resource,
          scope: q.scope ?? SCOPE,
          expiresAt: Date.now() + 60_000,
        });
        stats.authorizations++;
        back.searchParams.set("code", code);
        return Response.redirect(back.href, 302);
      }
      if (p === "/auth/token" && req.method === "POST") {
        const form = new URLSearchParams(await req.text());
        const c = authClient(req, form);
        if (!c) return oauthError("invalid_client", "unknown client", 401);
        if (form.get("resource") !== resource()) return oauthError("invalid_target", "wrong resource");
        const grantType = form.get("grant_type");
        if (grantType === "authorization_code") {
          const code = codes.get(form.get("code") ?? "");
          codes.delete(form.get("code") ?? "");
          if (!code || code.expiresAt < Date.now() || code.clientId !== c.clientId) {
            return oauthError("invalid_grant", "bad code");
          }
          if (form.get("redirect_uri") !== code.redirectUri)
            return oauthError("invalid_grant", "redirect_uri");
          if (S256(form.get("code_verifier") ?? "") !== code.challenge) {
            return oauthError("invalid_grant", "PKCE verification failed");
          }
          const id = token();
          grants.set(id, { clientId: c.clientId, scope: code.scope, subject: "tester", revoked: false });
          stats.tokens++;
          return issueTokens(id);
        }
        if (grantType === "refresh_token" && !options.t3Like) {
          const rt = form.get("refresh_token") ?? "";
          const id = refresh.get(rt);
          const g = id ? grants.get(id) : undefined;
          if (!id || !g || g.revoked || g.clientId !== c.clientId) {
            return oauthError("invalid_grant", "refresh token invalid");
          }
          refresh.delete(rt); // rotation
          stats.refreshes++;
          return issueTokens(id);
        }
        return oauthError("unsupported_grant_type", String(grantType));
      }
      if (p === "/auth/revoke" && req.method === "POST") {
        const form = new URLSearchParams(await req.text());
        if (!authClient(req, form)) return oauthError("invalid_client", "unknown client", 401);
        const t = form.get("token") ?? "";
        const id = refresh.get(t) ?? access.get(t)?.grant;
        const g = id ? grants.get(id) : undefined;
        if (g) g.revoked = true;
        stats.revocations++;
        return new Response(null, { status: 200 });
      }

      // ---- test controls ----
      if (p === "/test/expire" && req.method === "POST") {
        for (const a of access.values()) a.expiresAt = 0;
        return json({ ok: true });
      }
      if (p === "/test/revoke-all" && req.method === "POST") {
        for (const g of grants.values()) g.revoked = true;
        return json({ ok: true });
      }
      if (p === "/test/stats") return json(stats);
      return new Response("not found", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${srv.port}`;
  return {
    base,
    url: resource(),
    issuer: issuer(),
    stats,
    options,
    expireAccessTokens() {
      for (const a of access.values()) a.expiresAt = 0;
    },
    revokeAll() {
      for (const g of grants.values()) g.revoked = true;
    },
    addClient(c) {
      clients.set(c.clientId, c);
    },
    stop: () => srv.stop(true),
  };
}

if (import.meta.main) {
  const s = startOAuthMcpServer(Number(process.argv[2] ?? 0));
  console.log(`OAUTH_MCP_URL=${s.url}`);
  const stop = () => void s.stop().then(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

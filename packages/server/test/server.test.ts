import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentView,
  DeviceResponse,
  DevicesResponse,
  Harness,
  Message,
  MessagesResponse,
  MintLinkResponse,
  ServerEvent,
} from "@vibe-center/shared";
import { LINK_TOKEN_TTL_MS, UI_LINK_RATE_LIMIT } from "../src/auth/auth.ts";
import { dataPaths } from "../src/config.ts";
import { requestLink, startControlServer } from "../src/control.ts";
import { type AppServer, createServer } from "../src/server.ts";

const FAKE_AGENT = join(import.meta.dir, "fake-agent.ts");

let app: AppServer;
let base: string;
let cookie = "";
let dataDir: string;
let control: { stop(): void };

async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const res = await rawApi(path, init);
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${res.status} ${await res.text()}`);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

function rawApi(path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  // A test impersonating another device passes its own `cookie` header; don't clobber it.
  if (cookie && !headers.has("cookie")) headers.set("cookie", cookie);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  return fetch(`${base}${path}`, {
    ...init,
    headers,
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
  });
}

/** Collects WS events; `until` resolves when a matching one has arrived. */
function connectWs(deviceCookie = cookie) {
  const events: ServerEvent[] = [];
  const waiters: { pred: (e: ServerEvent) => boolean; resolve: (e: ServerEvent) => void }[] = [];
  const ws = new WebSocket(`${base.replace("http", "ws")}/ws`, {
    headers: { cookie: deviceCookie },
  } as never);
  ws.onmessage = (m) => {
    const e = JSON.parse(String(m.data)) as ServerEvent;
    events.push(e);
    for (const w of [...waiters]) {
      if (w.pred(e)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(e);
      }
    }
  };
  const opened = new Promise<void>((r) => {
    ws.onopen = () => r();
  });
  const closed = new Promise<number>((r) => {
    ws.onclose = (e) => r(e.code);
  });
  const until = <T extends ServerEvent>(pred: (e: ServerEvent) => boolean, ms = 5000): Promise<T> => {
    const hit = events.find(pred);
    if (hit) return Promise.resolve(hit as T);
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timed out waiting for event")), ms);
      waiters.push({
        pred,
        resolve: (e) => {
          clearTimeout(t);
          resolve(e as T);
        },
      });
    });
  };
  return { ws, events, opened, closed, until };
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "vc-server-"));
  app = createServer({ dataDir, port: 0, webDist: null, timeouts: { idleMs: 3000, cancelGraceMs: 500 } });
  base = `http://127.0.0.1:${app.port}`;
  control = await startControlServer(dataPaths(dataDir).controlSocket, {
    link: () => ({
      url: `${base}/login#token=${app.services.auth.mintLinkToken()}`,
      localUrl: "",
      expiresInMinutes: 10,
    }),
  });
});

afterAll(async () => {
  control.stop();
  await app.stop();
});

describe("auth", () => {
  test("API and WS refuse requests without a device session", async () => {
    expect((await rawApi("/api/agents")).status).toBe(401);
    const ws = connectWs();
    expect(await ws.closed).not.toBe(1000);
  });

  test("`link` mints a single-use token over the 0600 control socket", async () => {
    expect(statSync(dataPaths(dataDir).controlSocket).mode & 0o777).toBe(0o600);
    const { url } = await requestLink(dataPaths(dataDir).controlSocket);
    const token = url.split("#token=")[1]!;
    const res = await rawApi("/api/auth/exchange", { method: "POST", json: { token, deviceName: "test" } });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie")!;
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Strict");
    cookie = setCookie.split(";")[0]!;
    const again = await fetch(`${base}/api/auth/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(again.status).toBe(401);
    const me = await api<{ device: { name: string } }>("/api/auth/me");
    expect(me.device.name).toBe("test");
  });

  test("cross-origin mutations are refused", async () => {
    const res = await rawApi("/api/agents", {
      method: "POST",
      json: {},
      headers: { origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
  });
});

describe("device links (Settings → Devices → Add device)", () => {
  let cookie2 = "";

  test("minting one needs a device session and a same-origin request", async () => {
    const noSession = await fetch(`${base}/api/devices/links`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(noSession.status).toBe(401);

    const crossOrigin = await rawApi("/api/devices/links", {
      method: "POST",
      json: {},
      headers: { origin: "https://evil.example" },
    });
    expect(crossOrigin.status).toBe(403);
  });

  test("a minted link pre-assigns a name, is single-use, and pairing shows live", async () => {
    // Sign in a second device to mint the link from, distinct from the suite's main device.
    const { url } = await requestLink(dataPaths(dataDir).controlSocket);
    const exch = await rawApi("/api/auth/exchange", {
      method: "POST",
      json: { token: url.split("#token=")[1]!, deviceName: "Laptop" },
    });
    cookie2 = exch.headers.get("set-cookie")!.split(";")[0]!;
    const ws2 = connectWs(cookie2);
    await ws2.opened;

    const before = Date.now();
    const mint = await api<MintLinkResponse>("/api/devices/links", {
      method: "POST",
      json: { label: "Phone" },
      headers: { cookie: cookie2 },
    });
    expect(mint.url).toContain("/login#token=");
    expect(mint.label).toBe("Phone");
    expect(mint.expiresAt).toBeGreaterThan(before);
    expect(mint.expiresAt).toBeLessThanOrEqual(before + LINK_TOKEN_TTL_MS + 1000);

    const token = mint.url.split("#token=")[1]!;
    const redeemed = await rawApi("/api/auth/exchange", { method: "POST", json: { token } });
    expect(redeemed.status).toBe(200);
    const { device } = (await redeemed.json()) as { device: { name: string } };
    expect(device.name).toBe("Phone"); // the pre-assigned label, not a UA-derived name

    const paired = await ws2.until<Extract<ServerEvent, { type: "device.link.paired" }>>(
      (e) => e.type === "device.link.paired" && e.linkId === mint.id,
    );
    expect(paired.device.name).toBe("Phone");

    const list = await api<DevicesResponse>("/api/devices", { headers: { cookie: cookie2 } });
    expect(list.some((d) => d.name === "Phone")).toBe(true);

    // single-use: the same token doesn't redeem twice
    const again = await rawApi("/api/auth/exchange", { method: "POST", json: { token } });
    expect(again.status).toBe(401);
  });

  test("cancelling an outstanding link invalidates it", async () => {
    const mint = await api<MintLinkResponse>("/api/devices/links", {
      method: "POST",
      json: {},
      headers: { cookie: cookie2 },
    });
    await api(`/api/devices/links/${mint.id}`, { method: "DELETE", headers: { cookie: cookie2 } });

    const res = await rawApi("/api/auth/exchange", {
      method: "POST",
      json: { token: mint.url.split("#token=")[1]! },
    });
    expect(res.status).toBe(401);

    const cancelAgain = await rawApi(`/api/devices/links/${mint.id}`, {
      method: "DELETE",
      headers: { cookie: cookie2 },
    });
    expect(cancelAgain.status).toBe(404);
  });

  test("renaming a device", async () => {
    const me = await api<{ device: { id: string } }>("/api/auth/me", { headers: { cookie: cookie2 } });
    const renamed = await api<DeviceResponse>(`/api/devices/${me.device.id}`, {
      method: "PATCH",
      json: { name: "My Laptop" },
      headers: { cookie: cookie2 },
    });
    expect(renamed.name).toBe("My Laptop");
  });

  test("rate-limits minting past a few per minute", async () => {
    const { url } = await requestLink(dataPaths(dataDir).controlSocket);
    const exch = await rawApi("/api/auth/exchange", {
      method: "POST",
      json: { token: url.split("#token=")[1]!, deviceName: "RateLimited" },
    });
    const cookie3 = exch.headers.get("set-cookie")!.split(";")[0]!;

    for (let i = 0; i < UI_LINK_RATE_LIMIT; i++) {
      const res = await rawApi("/api/devices/links", {
        method: "POST",
        json: {},
        headers: { cookie: cookie3 },
      });
      expect(res.status).toBe(201);
    }
    const limited = await rawApi("/api/devices/links", {
      method: "POST",
      json: {},
      headers: { cookie: cookie3 },
    });
    expect(limited.status).toBe(429);
  });
});

describe("chat against the fake harness", () => {
  let agent: AgentView;

  test("custom harness env values are write-only, and still reach the process", async () => {
    const secret = "sk-secret-value-123456";
    const created = await api<Harness>("/api/harnesses", {
      method: "POST",
      json: {
        name: "Keyed",
        command: process.execPath,
        args: [FAKE_AGENT],
        env: { API_KEY: secret, MODE: "x" },
      },
    });
    expect(created.env).toEqual({ API_KEY: { hint: "3456" }, MODE: { hint: "" } });
    const listed = await api<Harness[]>("/api/harnesses");
    expect(JSON.stringify(listed)).not.toContain(secret);
    // keep the key, drop MODE
    const edited = await api<Harness>(`/api/harnesses/${created.id}`, {
      method: "PATCH",
      json: { env: { API_KEY: { keep: true } } },
    });
    expect(edited.env).toEqual({ API_KEY: { hint: "3456" } });
    const bad = await rawApi(`/api/harnesses/${created.id}`, {
      method: "PATCH",
      json: { env: { NEW: { keep: true } } },
    });
    expect(bad.status).toBe(400);
    const keyed = await api<AgentView>("/api/agents", {
      method: "POST",
      json: { name: "Keyed", avatar: { emoji: "🔑", color: "#888888" }, harnessId: created.id, cwd: dataDir },
    });
    const r = await app.services.chat.prompt(keyed.id, { text: "printenv API_KEY", source: "user" }).done;
    expect(r.text).toBe(`API_KEY=${secret}`);
    await api(`/api/agents/${keyed.id}`, { method: "DELETE" });
  });

  test("the data dir is 0700 and the database 0600", () => {
    const mode = (p: string) => statSync(p).mode & 0o777;
    expect(mode(dataDir)).toBe(0o700);
    expect(mode(join(dataDir, "vibe-center.db"))).toBe(0o600);
    expect(mode(join(dataDir, "vibe-center.db-wal"))).toBe(0o600);
  });

  test("presets are seeded; a custom harness and an agent can be created", async () => {
    const harnesses = await api<Harness[]>("/api/harnesses");
    expect(harnesses.map((h) => h.id)).toEqual(expect.arrayContaining(["claude-code", "opencode"]));
    const fake = await api<Harness>("/api/harnesses", {
      method: "POST",
      json: { name: "Fake", command: process.execPath, args: [FAKE_AGENT] },
    });
    const probed = await api<Harness>(`/api/harnesses/${fake.id}/probe`, { method: "POST" });
    expect(probed.health.status).toBe("ok");
    expect(probed.probe?.configOptions.find((o) => o.id === "model")).toBeTruthy();
    agent = await api<AgentView>("/api/agents", {
      method: "POST",
      json: {
        name: "Echo",
        avatar: { emoji: "🦜", color: "#22aa88" },
        systemPrompt: "You are Echo.",
        harnessId: fake.id,
        model: "fake-smart",
        cwd: dataDir,
      },
    });
    expect(agent.presence).toBe("idle");
  });

  test("a message streams a reply over the WS channel and persists it", async () => {
    const ws = connectWs();
    await ws.opened;
    await ws.until((e) => e.type === "hello");
    await api(`/api/conversations/${agent.conversationId}/messages`, {
      method: "POST",
      json: { text: "whoami" },
    });
    await ws.until((e) => e.type === "agent.presence" && e.presence === "thinking");
    await ws.until((e) => e.type === "message.delta");
    const final = await ws.until<Extract<ServerEvent, { type: "message.upsert" }>>(
      (e) => e.type === "message.upsert" && e.message.role === "agent" && e.message.status === "complete",
    );
    expect(final.message.text).toContain("SYSTEM=[You are Echo.]");
    expect(final.message.text).toContain("MODEL=[fake-smart]");
    await ws.until((e) => e.type === "agent.presence" && e.presence === "idle");
    const unread = ws.events.filter((e) => e.type === "conversation.unread").at(-1);
    expect(unread?.type === "conversation.unread" && unread.unread).toBe(1);
    const { messages } = await api<MessagesResponse>(`/api/conversations/${agent.conversationId}/messages`);
    expect(messages.map((m) => `${m.role}:${m.kind}`)).toEqual(["user:text", "agent:text"]);
    ws.ws.close();
  });

  test("cancel stops a streaming reply", async () => {
    const ws = connectWs();
    await ws.opened;
    await api(`/api/conversations/${agent.conversationId}/messages`, {
      method: "POST",
      json: { text: "slow" },
    });
    await ws.until((e) => e.type === "message.delta");
    await api(`/api/conversations/${agent.conversationId}/cancel`, { method: "POST" });
    const end = await ws.until<Extract<ServerEvent, { type: "message.upsert" }>>(
      (e) => e.type === "message.upsert" && e.message.role === "agent" && e.message.status === "cancelled",
    );
    expect(end.message.text).toContain("chunk 0.");
    ws.ws.close();
  });

  test("tool calls become messages; permission requests are answered from the API", async () => {
    const ws = connectWs();
    await ws.opened;
    await api(`/api/conversations/${agent.conversationId}/messages`, {
      method: "POST",
      json: { text: "permission please" },
    });
    const perm = await ws.until<Extract<ServerEvent, { type: "message.upsert" }>>(
      (e) => e.type === "message.upsert" && e.message.kind === "permission",
    );
    await ws.until((e) => e.type === "agent.presence" && e.presence === "waiting");
    await api(`/api/messages/${perm.message.id}/permission`, { method: "POST", json: { optionId: "allow" } });
    await ws.until(
      (e) => e.type === "message.upsert" && e.message.kind === "text" && e.message.text.includes("granted"),
    );
    const { messages } = await api<MessagesResponse>(`/api/conversations/${agent.conversationId}/messages`);
    const tool = messages.find((m): m is Extract<Message, { kind: "tool_call" }> => m.kind === "tool_call");
    expect(tool?.data.toolStatus).toBe("completed");
    const answered = messages.find((m) => m.id === perm.message.id);
    expect(answered?.kind === "permission" && answered.data.outcome).toEqual({ optionId: "allow" });
    ws.ws.close();
  });

  test("new session adds a divider and starts a fresh ACP session", async () => {
    await api(`/api/conversations/${agent.conversationId}/sessions`, { method: "POST" });
    const handle = app.services.chat.prompt(agent.id, {
      text: "history",
      source: "event",
      display: "hidden",
    });
    const result = await handle.done;
    expect(result.text).toBe("This session has seen 1 prompts.");
    const { messages } = await api<MessagesResponse>(`/api/conversations/${agent.conversationId}/messages`);
    expect(messages.filter((m) => m.kind === "session")).toHaveLength(1);
  });

  test("programmatic prompts (voice) record both sides as voice transcripts", async () => {
    const updates: string[] = [];
    const handle = app.services.chat.prompt(agent.id, {
      text: "hello by voice",
      source: "voice",
      display: "voice_transcript",
      replyKind: "voice_transcript",
      note: "[voice mode: short spoken replies]",
      onUpdate: (u) => updates.push(u.sessionUpdate),
    });
    const result = await handle.done;
    expect(result.text).toContain("Echo: [voice mode: short spoken replies]\nhello by voice");
    expect(updates).toContain("agent_message_chunk");
    const { messages } = await api<MessagesResponse>(`/api/conversations/${agent.conversationId}/messages`);
    expect(messages.slice(-2).map((m) => `${m.role}:${m.kind}`)).toEqual([
      "user:voice_transcript",
      "agent:voice_transcript",
    ]);
    expect(messages.at(-2)?.text).toBe("hello by voice");
  });

  test("search finds finished messages", async () => {
    const hits = await api<{ snippet: string }[]>("/api/search?q=granted");
    expect(hits[0]?.snippet).toContain("<mark>granted</mark>");
  });

  test("revoking a device closes its sockets and rejects its cookie", async () => {
    const ws = connectWs();
    await ws.opened;
    const me = await api<{ device: { id: string } }>("/api/auth/me");
    await api(`/api/devices/${me.device.id}`, { method: "DELETE" });
    expect(await ws.closed).toBe(4401);
    expect((await rawApi("/api/agents")).status).toBe(401);
  });
});

describe("event channel heartbeat", () => {
  test("a client that stops pinging is dropped; one that pings stays", async () => {
    const quick = createServer({ dataDir, port: 0, webDist: null, wsSilentMs: 300 });
    try {
      const url = `ws://127.0.0.1:${quick.port}/ws`;
      const token = quick.services.auth.mintLinkToken();
      const res = await fetch(`http://127.0.0.1:${quick.port}/api/auth/exchange`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const c = res.headers.get("set-cookie")!.split(";")[0]!;
      const open = (ping: boolean) => {
        const ws = new WebSocket(url, { headers: { cookie: c } } as never);
        let timer: ReturnType<typeof setInterval> | undefined;
        ws.onopen = () => {
          if (ping) timer = setInterval(() => ws.send(JSON.stringify({ type: "ping" })), 50);
        };
        const closed = new Promise<boolean>((r) => {
          ws.onclose = () => {
            clearInterval(timer);
            r(true);
          };
        });
        return { ws, closed, stop: () => clearInterval(timer) };
      };
      const silent = open(false);
      const alive = open(true);
      expect(await silent.closed).toBe(true);
      expect(await Promise.race([alive.closed, Bun.sleep(600).then(() => false)])).toBe(false);
      alive.stop();
      alive.ws.close();
    } finally {
      await quick.stop();
    }
  });
});

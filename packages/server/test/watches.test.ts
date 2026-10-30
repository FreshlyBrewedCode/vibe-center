import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentView,
  Harness,
  McpServerView,
  Message,
  ServerEvent,
  TurnMeta,
  Watch,
} from "@vibe-center/shared";
import { WATCH_LIMITS } from "../src/domain/watches.ts";
import { type AppServer, createServer } from "../src/server.ts";

// Background waits: watches registered through the built-in tools, fired by the app, delivered
// as new `event` turns (combined while the agent is busy), surviving a restart.
setDefaultTimeout(30_000);
const FAKE_AGENT = join(import.meta.dir, "fake-agent.ts");
const UPSTREAM = join(import.meta.dir, "fixtures/stdio-mcp-server.ts");

interface App {
  app: AppServer;
  base: string;
  cookie: string;
}

async function boot(dataDir: string): Promise<App> {
  const app = createServer({
    dataDir,
    port: 0,
    webDist: null,
    timeouts: { idleMs: 10_000, cancelGraceMs: 500 },
  });
  const base = `http://127.0.0.1:${app.port}`;
  const res = await fetch(`${base}/api/auth/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: app.services.auth.mintLinkToken() }),
  });
  return { app, base, cookie: res.headers.get("set-cookie")!.split(";")[0]! };
}

async function api<T>(a: App, path: string, init: { method?: string; json?: unknown } = {}): Promise<T> {
  const res = await fetch(`${a.base}${path}`, {
    method: init.method ?? "GET",
    headers: {
      cookie: a.cookie,
      origin: a.base,
      ...(init.json !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
  });
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${res.status} ${await res.text()}`);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

async function until<T>(fn: () => T | undefined | null | false, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await Bun.sleep(25);
  }
  throw new Error("timed out");
}

const messages = (a: App, agent: AgentView): Message[] =>
  a.app.services.repos.messages.list(agent.conversationId, { limit: 500 }).messages;

const watchOf = (m: Message) => (m.data as TurnMeta | null)?.watch;

/** Event prompts from fired watches, oldest first. */
const firedPrompts = (a: App, agent: AgentView) =>
  messages(a, agent).filter(
    (m) => m.role === "user" && m.kind === "text" && m.data?.source === "event" && m.data.watch,
  );

async function ask(a: App, agent: AgentView, text: string): Promise<string> {
  const r = await a.app.services.chat.prompt(agent.id, { text, source: "user" }).done;
  if (r.status !== "complete") throw new Error(`turn ${r.status}: ${r.error}`);
  return r.text;
}

const callTool = (a: App, agent: AgentView, tool: string, args: unknown) =>
  ask(a, agent, `mcp-call ${tool} ${JSON.stringify(args)}`);

async function setup(a: App, name: string): Promise<{ harness: Harness; agent: AgentView }> {
  const harness = await api<Harness>(a, "/api/harnesses", {
    method: "POST",
    json: { name: `Fake ${name}`, command: process.execPath, args: [FAKE_AGENT] },
  });
  const agent = await api<AgentView>(a, "/api/agents", {
    method: "POST",
    json: { name, avatar: { emoji: "🤖", color: "#336699" }, harnessId: harness.id, cwd: tmpdir() },
  });
  return { harness, agent };
}

let a: App;
let agent: AgentView;
const seen: ServerEvent[] = [];

beforeAll(async () => {
  a = await boot(mkdtempSync(join(tmpdir(), "vc-watch-")));
  a.app.services.bus.subscribe((e) => seen.push(e));
  ({ agent } = await setup(a, "Waiter"));
});

afterAll(async () => {
  await a.app.stop();
});

describe("watches", () => {
  test("watch_timer: the turn ends at once, the timer starts a new turn with the note", async () => {
    const reply = await callTool(a, agent, "watch_timer", {
      note: "look at the deploy dashboard",
      in_minutes: 0.01,
    });
    expect(reply).toContain("Timer set");
    const w = await until(() => a.app.services.watches.list(agent.id).find((x) => x.kind === "timer"));
    expect(w).toMatchObject({ status: "active", label: "Timer: 1 s", note: "look at the deploy dashboard" });

    const prompt = await until(() => firedPrompts(a, agent)[0]);
    expect(prompt.text).toMatch(/^Timer: 1 s is up/);
    expect(prompt.data).toMatchObject({ watch: { label: "Timer: 1 s", watchIds: [w.id] } });
    // the agent answered in that new turn; the hidden note carried why it cared
    const answer = await until(() =>
      messages(a, agent).find(
        (m) => m.role === "agent" && m.turnId === prompt.turnId && m.status === "complete",
      ),
    );
    expect(answer.text).toContain("look at the deploy dashboard");
    expect(a.app.services.watches.get(w.id)).toMatchObject({ status: "fired", fireCount: 1 });
    expect(
      seen.some((e) => e.type === "watch.upsert" && e.watch.id === w.id && e.watch.status === "fired"),
    ).toBe(true);
  });

  test("call_in_background: a blocking upstream tool runs without blocking the turn", async () => {
    const server = await api<McpServerView>(a, "/api/mcp/servers", {
      method: "POST",
      json: { name: "slowpoke", transport: "stdio", command: process.execPath, args: [UPSTREAM] },
    });
    await until(() => a.app.services.repos.mcpServers.get(server.id)?.tools.length);
    await api(a, `/api/agents/${agent.id}/tools`, {
      method: "PATCH",
      json: { serverId: server.id, enabled: true },
    });
    // a disabled or unknown tool is refused up front
    expect(await callTool(a, agent, "call_in_background", { tool: "nope__x", note: "n" })).toContain(
      "not available",
    );

    const before = firedPrompts(a, agent).length;
    const t0 = Date.now();
    const reply = await callTool(a, agent, "call_in_background", {
      // Claude Code's name for it works too
      tool: "mcp__vibe__slowpoke__wait",
      arguments: { ms: 1500, text: "thread answered" },
      note: "tell the user what the other thread said",
    });
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(reply).toContain("Started slowpoke__wait in the background");
    const prompt = await until(() => firedPrompts(a, agent)[before]);
    expect(prompt.text).toBe("slowpoke__wait finished:\nwaited: thread answered");
    // the existing blocking way still works
    expect(await callTool(a, agent, "slowpoke__wait", { ms: 10, text: "now" })).toBe("Result: waited: now");
  });

  test("while the agent is busy, events wait for its turn to end and arrive as one prompt", async () => {
    const before = firedPrompts(a, agent).length;
    const typed = a.app.services.chat.prompt(agent.id, { text: "slow", source: "user" });
    await until(() => a.app.services.chat.busy(agent.id));
    const w1 = a.app.services.watches.timer({
      agentId: agent.id,
      turnId: null,
      note: "first",
      fireAt: Date.now() + 100,
      label: "One",
    });
    const w2 = a.app.services.watches.timer({
      agentId: agent.id,
      turnId: null,
      note: "second",
      fireAt: Date.now() + 200,
      label: "Two",
    });
    await until(() => a.app.services.watches.get(w2.id)?.status === "fired");
    expect(firedPrompts(a, agent).length).toBe(before); // nothing jumped into the running turn
    await typed.done;
    const prompt = await until(() => firedPrompts(a, agent)[before]);
    expect(watchOf(prompt)?.watchIds).toEqual([w1.id, w2.id]);
    expect(prompt.text).toMatch(/^\(1\) One is up.*\n\n\(2\) Two is up/s);
    // it came after the user's turn, not in the middle of it
    const reply = messages(a, agent).find((m) => m.turnId === typed.turnId && m.role === "agent");
    expect(reply!.seq).toBeLessThan(prompt.seq);
  });

  test("webhook: a POST with the secret fires it once with the body; anything else is refused", async () => {
    const { watch, urls } = a.app.services.watches.webhook({
      agentId: agent.id,
      turnId: null,
      note: "CI result",
    });
    expect(urls).toHaveLength(1);
    const url = urls[0]!;
    expect(url).toStartWith(`${a.base}/hooks/w/${watch.id}/`);
    const wrong = await fetch(`${a.base}/hooks/w/${watch.id}/not-the-secret`, { method: "POST" });
    expect(wrong.status).toBe(404);
    expect((await fetch(url)).status).toBe(405);

    const before = firedPrompts(a, agent).length;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ build: "green" }),
    });
    expect(res.status).toBe(202);
    const prompt = await until(() => firedPrompts(a, agent)[before]);
    expect(prompt.text).toBe('Webhook received a POST (application/json):\n{"build":"green"}');
    expect((await fetch(url, { method: "POST" })).status).toBe(410);
  });

  test("the UI lists and cancels watches; cancelled ones never fire; the active limit holds", async () => {
    const before = firedPrompts(a, agent).length;
    const w = a.app.services.watches.timer({
      agentId: agent.id,
      turnId: null,
      note: "never",
      fireAt: Date.now() + 300,
    });
    const listed = await api<Watch[]>(a, `/api/agents/${agent.id}/watches`);
    expect(listed[0]).toMatchObject({ id: w.id, status: "active" });
    expect(JSON.stringify(listed)).not.toContain("secret");
    const cancelled = await api<Watch>(a, `/api/watches/${w.id}`, { method: "DELETE" });
    expect(cancelled.status).toBe("cancelled");
    await Bun.sleep(500);
    expect(firedPrompts(a, agent).length).toBe(before);

    const many = Array.from({ length: WATCH_LIMITS.active }, () =>
      a.app.services.watches.timer({
        agentId: agent.id,
        turnId: null,
        note: "x",
        fireAt: Date.now() + 3600_000,
      }),
    );
    expect(await callTool(a, agent, "watch_timer", { note: "one more", in_minutes: 5 })).toContain(
      `limit ${WATCH_LIMITS.active}`,
    );
    // the agent sees and cancels its own
    expect(await callTool(a, agent, "list_watches", {})).toContain(many[0]!.id);
    expect(await callTool(a, agent, "cancel_watch", { id: many[0]!.id })).toContain("Cancelled");
    for (const x of many.slice(1)) a.app.services.watches.cancel(x.id);
  });

  test("send_message_to_agent shows as a reply watch until the reply arrives", async () => {
    const { agent: other } = await setup(a, "Other");
    const before = firedPrompts(a, agent).length;
    await callTool(a, agent, "send_message_to_agent", { agent: "Other", message: "slow" });
    const w = await until(() => a.app.services.watches.list(agent.id).find((x) => x.kind === "agent_reply"));
    expect(w.label).toBe("Reply from Other");
    const prompt = await until(() => firedPrompts(a, agent)[before], 15_000);
    expect(prompt.data).toMatchObject({ source: "event", fromAgentId: other.id });
    expect(a.app.services.watches.get(w.id)?.status).toBe("fired");
  });
});

describe("restarts", () => {
  test("timers survive a restart; a background call cut by one is reported", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vc-watch-restart-"));
    let b = await boot(dir);
    const { agent: ag } = await setup(b, "Sleeper");
    const timer = b.app.services.watches.timer({
      agentId: ag.id,
      turnId: null,
      note: "after the restart",
      fireAt: Date.now() + 1500,
      label: "Later",
    });
    // a background call that can't finish before the stop (stored as active)
    const call = b.app.services.repos.watches.insert({
      agentId: ag.id,
      kind: "tool",
      label: "slowpoke__wait",
      note: "waiting on a thread",
    });
    await b.app.stop();

    b = await boot(dir);
    try {
      const failed = await until(() =>
        firedPrompts(b, ag).find((m) => watchOf(m)?.watchIds.includes(call.id)),
      );
      expect(failed.text).toContain("interrupted by a restart");
      expect(b.app.services.watches.get(call.id)?.status).toBe("failed");
      const fired = await until(() =>
        firedPrompts(b, ag).find((m) => watchOf(m)?.watchIds.includes(timer.id)),
      );
      expect(fired.text).toMatch(/^Later is up/);
    } finally {
      await b.app.stop();
    }
  });
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { AgentToolGroup, AgentView, Harness, McpServerView, Memory, Message } from "@vibe-center/shared";
import { adapters } from "../src/acp/adapters/index.ts";
import { MAX_HOPS } from "../src/mcp/builtin/agents.ts";
import { type AppServer, createServer } from "../src/server.ts";

const FAKE_AGENT = join(import.meta.dir, "fake-agent.ts");
const UPSTREAM = join(import.meta.dir, "fixtures/stdio-mcp-server.ts");
const SECRET = "supersecretvalue-1234";

let app: AppServer;
let base: string;
let cookie = "";
let dataDir: string;
let harness: Harness;
let alice: AgentView;
let bob: AgentView;
/** Credentials are minted here directly: minting revokes the agent's previous one. */
let probe: AgentView;

async function api<T>(path: string, init: { method?: string; json?: unknown } = {}): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers: { cookie, ...(init.json !== undefined ? { "content-type": "application/json" } : {}) },
    body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
  });
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${res.status} ${await res.text()}`);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

/** Prompt an agent as the user and wait for its reply text. */
async function ask(agent: AgentView, text: string): Promise<string> {
  const r = await app.services.chat.prompt(agent.id, { text, source: "user" }).done;
  if (r.status !== "complete") throw new Error(`turn ${r.status}: ${r.error}`);
  return r.text;
}

const call = (agent: AgentView, tool: string, args: unknown = {}) =>
  ask(agent, `mcp-call ${tool} ${JSON.stringify(args)}`);

function messages(agent: AgentView): Message[] {
  return app.services.repos.messages.list(agent.conversationId, { limit: 500 }).messages;
}

async function until<T>(
  fn: () => T | undefined | null | false | Promise<T | undefined | null | false>,
  ms = 8000,
): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await Bun.sleep(25);
  }
  throw new Error("timed out");
}

/** No turn queued or running anywhere for a moment. */
async function settled(): Promise<void> {
  const busy = () =>
    app.services.repos.db
      .query<{ n: number }, []>("SELECT count(*) AS n FROM turns WHERE status IN ('queued', 'running')")
      .get()!.n;
  let quiet = 0;
  await until(() => {
    quiet = busy() === 0 ? quiet + 1 : 0;
    return quiet >= 10;
  }, 20_000);
}

async function newAgent(name: string, harnessId = harness.id): Promise<AgentView> {
  return api<AgentView>("/api/agents", {
    method: "POST",
    json: { name, avatar: { emoji: "🤖", color: "#336699" }, harnessId, cwd: dataDir },
  });
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "vc-mcp-"));
  app = createServer({ dataDir, port: 0, webDist: null, timeouts: { idleMs: 10_000, cancelGraceMs: 500 } });
  base = `http://127.0.0.1:${app.port}`;
  const token = app.services.auth.mintLinkToken();
  const res = await fetch(`${base}/api/auth/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  harness = await api<Harness>("/api/harnesses", {
    method: "POST",
    json: { name: "Fake", command: process.execPath, args: [FAKE_AGENT] },
  });
  alice = await newAgent("Alice");
  bob = await newAgent("Bob");
  probe = await newAgent("Probe");
});

afterAll(async () => {
  await app.stop();
});

describe("gateway endpoint", () => {
  test("refuses missing and wrong credentials, and anything forwarded from outside", async () => {
    const init = (headers: Record<string, string>) => ({
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect((await fetch(`${base}/mcp`, init({}))).status).toBe(401);
    expect((await fetch(`${base}/mcp`, init({ authorization: "Bearer nope" }))).status).toBe(401);
    const { servers } = await app.services.mcp.gateway.forSession({ agentId: probe.id, sessionKey: "x" });
    const good = (servers[0] as { headers: { value: string }[] }).headers[0]!.value;
    const forwarded = await fetch(
      `${base}/mcp`,
      init({ authorization: good, "x-forwarded-for": "100.64.0.1" }),
    );
    expect(forwarded.status).toBe(403);
    // Minting a new credential for the agent revokes the old one.
    await app.services.mcp.gateway.forSession({ agentId: probe.id, sessionKey: "x" });
    expect((await fetch(`${base}/mcp`, init({ authorization: good }))).status).toBe(401);
  });

  test("ACP sessions get the gateway as one HTTP server with Claude Code's tools pre-allowed", async () => {
    const setup = await app.services.mcp.gateway.forSession({
      agentId: probe.id,
      sessionKey: "y",
      capabilities: { mcpCapabilities: { http: true } },
    });
    expect(setup.allowedTools).toEqual(["mcp__vibe"]);
    expect(setup.servers[0]).toMatchObject({ type: "http", name: "vibe", url: `${base}/mcp` });
    const stdio = await app.services.mcp.gateway.forSession({
      agentId: probe.id,
      sessionKey: "y",
      capabilities: { mcpCapabilities: { http: false } },
    });
    expect(stdio.servers[0]).toMatchObject({ name: "vibe", command: process.execPath });
  });

  test("Claude Code gets the token through its session env, not in the MCP config (its argv)", async () => {
    const setup = await app.services.mcp.gateway.forSession({
      agentId: probe.id,
      sessionKey: "z",
      capabilities: { mcpCapabilities: { http: true } },
    });
    const token = setup.credential!.token;
    const fields = adapters["claude-code"].sessionFields({
      agentId: probe.id,
      cwd: dataDir,
      systemPrompt: "",
      model: null,
      stateDir: dataDir,
      capabilities: { mcpCapabilities: { http: true } },
      mcp: setup,
    });
    expect(JSON.stringify(fields.mcpServers)).not.toContain(token);
    expect(fields.mcpServers?.[0]).toMatchObject({
      type: "http",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Claude Code expands it from the env
      headers: [{ name: "Authorization", value: "Bearer ${VIBE_MCP_TOKEN}" }],
    });
    const meta = fields._meta as { claudeCode: { options: { env: Record<string, string> } } };
    const options = meta.claudeCode.options;
    expect(options.env.VIBE_MCP_TOKEN).toBe(token);
  });
});

describe("MCP servers and tool selection", () => {
  let server: McpServerView;

  test("a stdio server is added, connected and its tools discovered; secrets never come back", async () => {
    server = await api<McpServerView>("/api/mcp/servers", {
      method: "POST",
      json: {
        name: "test",
        transport: "stdio",
        command: process.execPath,
        args: [UPSTREAM],
        env: { SECRET_TOKEN: SECRET, SHORT: "abc" },
      },
    });
    expect(server.env).toEqual({ SECRET_TOKEN: { hint: "1234" }, SHORT: { hint: "" } });
    const connected = await until(async () => {
      const s = await api<McpServerView>(`/api/mcp/servers/${server.id}`);
      return s.status.state === "connected" ? s : null;
    });
    const s = connected;
    expect(s.tools.map((t) => t.name).sort()).toEqual(["add", "echo", "env", "fail", "grow"]);
    expect(s.status.serverInfo?.name).toBe("test-upstream");
    const raw = await (await fetch(`${base}/api/mcp/servers`, { headers: { cookie } })).text();
    expect(raw).not.toContain("supersecret");
    expect(raw).not.toContain('"abc"');
    // Built-in server first.
    const list = await api<McpServerView[]>("/api/mcp/servers");
    expect(list[0]!.builtin).toBe(true);
    expect(list[0]!.tools.map((t) => t.name)).toContain("memory_save");
  });

  test("editing keeps secrets marked keep and drops the ones left out", async () => {
    await api(`/api/mcp/servers/${server.id}`, {
      method: "PATCH",
      json: { env: { SECRET_TOKEN: { keep: true } } },
    });
    const rec = app.services.repos.mcpServers.get(server.id)!;
    expect(rec.env).toEqual({ SECRET_TOKEN: SECRET });
    await until(() => app.services.repos.mcpServers.get(server.id)?.status.state === "connected");
  });

  test("tools are grouped by server: built-ins on by default, other servers off", async () => {
    const groups = await api<AgentToolGroup[]>(`/api/agents/${alice.id}/tools`);
    expect(groups[0]).toMatchObject({ builtin: true, enabled: true });
    expect(groups[0]!.tools.every((t) => t.enabled)).toBe(true);
    const test = groups.find((g) => g.serverName === "test")!;
    expect(test.enabled).toBe(false);
    expect(test.tools.find((t) => t.name === "echo")!.exposedName).toBe("test__echo");
    const listed = await ask(alice, "mcp-list");
    expect(listed).toContain("memory_save");
    expect(listed).toContain("send_message_to_agent");
    expect(listed).not.toContain("test__echo");
  });

  test("enabled upstream tools are proxied; env secrets reach the server", async () => {
    await api(`/api/agents/${alice.id}/tools`, {
      method: "PATCH",
      json: { serverId: server.id, enabled: true },
    });
    expect(await ask(alice, "mcp-list")).toContain("test__echo");
    expect(await call(alice, "test__echo", { text: "hi" })).toBe("Result: echo: hi");
    expect(await call(alice, "test__add", { a: 2, b: 40 })).toBe("Result: 42");
    expect(await call(alice, "test__env", { name: "SECRET_TOKEN" })).toBe(`Result: ${SECRET}`);
    expect(await call(alice, "test__fail")).toBe("Result: it broke");
  });

  test("gateway calls show on the harness's tool_call message: server, tool, args, result", async () => {
    const card = await until(() =>
      messages(alice).find(
        (m) =>
          m.kind === "tool_call" && m.data.gateway?.tool === "add" && m.data.gateway.status === "completed",
      ),
    );
    if (card.kind !== "tool_call") throw new Error("unreachable");
    expect(card.data.gateway).toMatchObject({
      server: "test",
      tool: "add",
      args: { a: 2, b: 40 },
      result: "42",
    });
    expect(card.data.toolStatus).toBe("completed"); // the harness's later updates keep the annotation
    const failed = messages(alice).find((m) => m.kind === "tool_call" && m.data.gateway?.tool === "fail");
    expect(failed?.kind === "tool_call" && failed.data.gateway?.status).toBe("failed");
  });

  test("a call the harness doesn't report still gets its own card", async () => {
    expect(await ask(alice, 'mcp-silent test__echo {"text":"quiet"}')).toBe("Result: echo: quiet");
    const card = await until(() =>
      messages(alice).find((m) => m.kind === "tool_call" && m.data.toolCallId.startsWith("gateway:")),
    );
    expect(card.text).toBe("test · echo");
  });

  test("a disabled tool is gone from the list and refused when called anyway", async () => {
    await api(`/api/agents/${alice.id}/tools`, {
      method: "PATCH",
      json: { serverId: server.id, tool: "env", enabled: false },
    });
    const listed = await ask(alice, "mcp-list");
    expect(listed).toContain("test__echo");
    expect(listed).not.toContain("test__env");
    expect(await call(alice, "test__env", { name: "SECRET_TOKEN" })).toContain(
      "is not available to this agent",
    );
    // Bob never enabled the server.
    expect(await call(bob, "test__echo", { text: "x" })).toContain("is not available to this agent");
  });

  test("tools a server adds later follow the server toggle", async () => {
    expect(await call(alice, "test__grow")).toBe("Result: grown");
    await until(() => app.services.repos.mcpServers.get(server.id)?.tools.some((t) => t.name === "extra"));
    expect(await ask(alice, "mcp-list")).toContain("test__extra");
    expect(await ask(bob, "mcp-list")).not.toContain("test__extra");
  });

  test("live sessions are told when an agent's tools change", async () => {
    const setup = await app.services.mcp.gateway.forSession({ agentId: probe.id, sessionKey: "live" });
    const s = setup.servers[0] as { url: string; headers: { name: string; value: string }[] };
    const client = new Client({ name: "probe", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(s.url), {
        requestInit: { headers: { authorization: s.headers[0]!.value } },
      }),
    );
    let changed = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      changed++;
    });
    const before = (await client.listTools()).tools.map((t) => t.name);
    expect(before).not.toContain("test__echo");
    await Bun.sleep(100); // let the client open its notification stream
    await api(`/api/agents/${probe.id}/tools`, {
      method: "PATCH",
      json: { serverId: server.id, enabled: true },
    });
    await until(() => changed > 0);
    expect((await client.listTools()).tools.map((t) => t.name)).toContain("test__echo");
    await client.close();
  });
});

describe("built-in tools", () => {
  test("memory: save, search, update, delete; own memories are private, shared ones are not", async () => {
    const saved = await call(alice, "memory_save", {
      content: "Karl's favourite colour is teal",
      tags: ["preference"],
    });
    const id = /memory (\S+) /.exec(saved)![1]!;
    await call(alice, "memory_save", { content: "The staging deploy runs on Fridays", scope: "shared" });
    expect(await call(alice, "memory_search", { query: "colour" })).toContain("teal");
    expect(await call(alice, "memory_search", { query: "preference" })).toContain("teal"); // by tag
    expect(await call(bob, "memory_search", { query: "colour" })).toContain("No memories match");
    expect(await call(bob, "memory_search", { query: "staging" })).toContain("Fridays");
    expect(await call(bob, "memory_delete", { id })).toContain("no memory with id");
    await call(alice, "memory_update", { id, content: "Karl's favourite colour is orange" });
    expect(await call(alice, "memory_list", { scope: "agent" })).toContain("orange");
    const listed = await api<Memory[]>(`/api/memories?scope=${alice.id}`);
    expect(listed.map((m) => m.content)).toEqual(["Karl's favourite colour is orange"]);
    expect((await api<Memory[]>("/api/memories?scope=shared"))[0]!.content).toContain("Fridays");
    await call(alice, "memory_delete", { id });
    expect(await call(alice, "memory_list", { scope: "agent" })).toBe("Result: No memories yet.");
  });

  test("conversation search finds earlier messages (own DM by default) and reads around a hit", async () => {
    await ask(bob, "The launch codename is pelican.");
    const own = await call(bob, "search_conversations", { query: "pelican" });
    expect(own).toContain("launch codename");
    expect(own).not.toContain("search_conversations"); // the request itself is left out
    expect(await call(alice, "search_conversations", { query: "pelican" })).toContain("No messages match");
    const all = await call(alice, "search_conversations", { query: "pelican", scope: "all", role: "user" });
    expect(all).toContain("DM with Bob");
    const id = /"id": "([^"]+)"/.exec(all)![1]!;
    const around = await call(alice, "read_conversation", { message_id: id, before: 1, after: 1 });
    expect(around).toContain(">>> ");
    expect(around).toContain("Echo: The launch codename is pelican.");
  });

  test("agents: list, message another agent, and get the reply back in your own session", async () => {
    const listed = await call(alice, "list_agents");
    expect(listed).toContain('"name": "Bob"');
    expect(await call(alice, "send_message_to_agent", { agent: "Alice", message: "hi me" })).toContain(
      "can't send a message to yourself",
    );
    const sent = await call(alice, "send_message_to_agent", { agent: "bob", message: "What is 6 times 7?" });
    expect(sent).toBe("Result: Sent to Bob. Their reply will arrive as a separate message later.");
    // Bob's DM: the message, marked as coming from Alice; and Bob's reply.
    const inBob = await until(() =>
      messages(bob).find((m) => m.role === "user" && m.text === "What is 6 times 7?"),
    );
    expect(inBob.data).toMatchObject({ source: "agent", fromAgentId: alice.id });
    // Alice's DM: Bob's reply arrives as an event from Bob, and Alice's harness gets it as a prompt.
    const reply = await until(() =>
      messages(alice).find(
        (m) =>
          m.role === "user" &&
          m.kind === "text" &&
          m.data?.source === "event" &&
          m.text.includes("6 times 7"),
      ),
    );
    expect(reply.data).toMatchObject({ source: "event", fromAgentId: bob.id });
    expect(reply.text).toContain("Echo:");
    await settled();
    const after = messages(alice).filter((m) => m.seq > reply.seq && m.role === "agent" && m.kind === "text");
    expect(after.at(-1)?.text).toContain("Reply from the agent");
  });

  test("agent ping-pong stops at the hop limit", async () => {
    await settled();
    const startSeq = app.services.repos.messages.latestSeq(alice.conversationId);
    await ask(alice, "pingpong Bob Alice");
    await settled();
    const sends = app.services.repos.db
      .query<{ result: string }, [number]>(
        `SELECT c.result FROM mcp_tool_calls c JOIN turns t ON t.id = c.turn_id
         WHERE c.tool = 'send_message_to_agent' AND t.created_at >= ?`,
      )
      .all(Date.now() - 60_000);
    expect(sends.some((s) => s.result.includes(`${MAX_HOPS} messages deep`))).toBe(true);
    const agentTurns = app.services.repos.db
      .query<{ n: number }, []>("SELECT count(*) AS n FROM turns WHERE source = 'agent'")
      .get()!.n;
    expect(agentTurns).toBeLessThan(20);
    expect(app.services.repos.messages.latestSeq(alice.conversationId)).toBeGreaterThan(startSeq);
  });

  test("deleting a busy agent: its harness stops, a waiting sender is told, nothing respawns it", async () => {
    await settled();
    const dave = await newAgent("Dave");
    const slow = app.services.chat.prompt(dave.id, { text: "slow please", source: "user" });
    const pid = await until(() => app.services.chat.pids()[dave.id]);
    // Alice's message queues behind Dave's running turn
    expect(
      await call(alice, "send_message_to_agent", { agent: "Dave", message: "Are you there?" }),
    ).toContain("Sent to Dave");
    const deleting = app.services.agents.delete(dave.id);
    // from the first moment, no prompt (UI, call, another agent) can start Dave's harness again
    expect(() => app.services.chat.prompt(dave.id, { text: "hi", source: "user" })).toThrow(/not found/);
    // (refused as "not available" while the deletion runs, as unknown once it's done)
    expect(await call(bob, "send_message_to_agent", { agent: "Dave", message: "Hello?" })).toMatch(
      /Dave is not available|no agent named "Dave"/,
    );
    await deleting;
    expect((await slow.done).status).toBe("cancelled");
    expect(() => process.kill(pid, 0)).toThrow();
    // Alice hears back instead of waiting forever
    const told = await until(() =>
      messages(alice).find(
        (m) => m.kind === "text" && m.data?.source === "event" && m.text.includes("Dave was deleted"),
      ),
    );
    expect(told.data).toMatchObject({ fromAgentId: dave.id });
    await settled();
    expect(app.services.chat.pids()[dave.id]).toBeUndefined();
    expect(await call(alice, "send_message_to_agent", { agent: "Dave", message: "Hello?" })).toContain(
      'no agent named "Dave"',
    );
  });

  test("harnesses without HTTP MCP reach the gateway through the stdio bridge", async () => {
    const stdioOnly = await api<Harness>("/api/harnesses", {
      method: "POST",
      json: {
        name: "Fake stdio-only",
        command: process.execPath,
        args: [FAKE_AGENT],
        env: { FAKE_ACP_NO_MCP_HTTP: "1" },
      },
    });
    const carol = await newAgent("Carol", stdioOnly.id);
    expect(await call(carol, "memory_save", { content: "Carol was here" })).toContain("Saved memory");
    expect(await call(carol, "memory_search", { query: "carol" })).toContain("Carol was here");
  });
});

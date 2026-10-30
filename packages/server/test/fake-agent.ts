#!/usr/bin/env bun
// A tiny scripted ACP agent for tests (bun test and the Playwright e2e use it as a custom
// harness: command `bun`, args [this file]). Behaviour is picked by keywords in the prompt:
//
//   (default)    streams "Echo: <prompt>" in a few chunks
//   slow         streams 40 chunks, 100 ms apart (for cancel tests)
//   tool         a tool call (pending → in_progress → completed), then text
//   permission   a tool call that asks for permission; replies with the outcome
//   thought      a thought chunk, then text
//   plan         a plan update, then text
//   hang         never answers and ignores session/cancel (like OpenCode on provider errors)
//   crash        exits with code 3 mid-turn
//   whoami       replies with the system prompt, model, mode and prompt blocks it received
//   history      replies with how many prompts this session has seen
//   printenv <NAME>  replies "NAME=<value>" from its own environment
//   mcp-call <tool> <json args>   calls the tool on the session's first MCP server (the app's
//                gateway), reported as a tool call like Claude Code does (title mcp__vibe__<tool>,
//                `_meta["claudecode/toolUseId"]`), then replies "Result: <text>"
//   mcp-silent <tool> <json args> the same without reporting the tool call over ACP
//   mcp-list     replies with the names of the MCP server's tools
//   pingpong <to> <me>  sends "pingpong <me> <to>" to agent <to> with send_message_to_agent
//   weather      a tool call before any text (a voice call plays a filler), then "It is sunny."
//
// A `<voice-call>` block (the voice-mode note) is left out of the echo and the keyword match.
//
// Env: FAKE_ACP_NO_SYSTEM_PROMPT=1 hides the systemPrompt capability, FAKE_ACP_NO_RESUME=1 the
// resume capability, FAKE_ACP_NO_MCP_HTTP=1 the HTTP MCP capability (stdio servers only), FAKE_ACP_STATE=<file> persists sessions so they can be resumed by a new
// process. FAKE_ACP_SLOW_SESSION=<ms> delays session/new. FAKE_ACP_STUBBORN=child|all starts a
// child that ignores SIGTERM (its pid goes to FAKE_ACP_CHILD_PID_FILE); with `all` the agent
// ignores SIGTERM too.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import * as acp from "../src/acp/protocol.ts";

interface FakeSession {
  systemPrompt: string;
  model: string;
  mode: string;
  prompts: number;
  mcpServers: acp.McpServer[];
}

const stubborn = process.env.FAKE_ACP_STUBBORN;
if (stubborn) {
  if (stubborn === "all") process.on("SIGTERM", () => {});
  // an ignored signal stays ignored across exec, so `sleep` shrugs off SIGTERM
  const child = spawn("bash", ["-c", 'trap "" TERM; exec sleep 600'], { stdio: "ignore" });
  if (process.env.FAKE_ACP_CHILD_PID_FILE)
    writeFileSync(process.env.FAKE_ACP_CHILD_PID_FILE, String(child.pid));
}

const statePath = process.env.FAKE_ACP_STATE;
const sessions = new Map<string, FakeSession>(
  statePath && existsSync(statePath) ? Object.entries(JSON.parse(readFileSync(statePath, "utf8"))) : [],
);
const save = () => {
  if (statePath) writeFileSync(statePath, JSON.stringify(Object.fromEntries(sessions)));
};
const running = new Map<string, AbortController>();
const mcpClients = new Map<string, Client>();

/** One MCP client per session, to the first server it was given (the app's gateway). */
async function mcpClient(sessionId: string, s: FakeSession): Promise<Client> {
  const existing = mcpClients.get(sessionId);
  if (existing) return existing;
  const server = s.mcpServers[0];
  if (!server) throw new Error("no MCP server in this session");
  const client = new Client({ name: "fake-agent", version: "1.0.0" });
  if ("type" in server && server.type === "http") {
    const headers = Object.fromEntries(server.headers.map((h) => [h.name, h.value]));
    await client.connect(
      new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers } }),
    );
  } else if (!("type" in server)) {
    const env = Object.fromEntries((server.env ?? []).map((e) => [e.name, e.value]));
    await client.connect(new StdioClientTransport({ command: server.command, args: server.args, env }));
  } else {
    throw new Error(`unsupported MCP server type ${server.type}`);
  }
  mcpClients.set(sessionId, client);
  return client;
}

const resultText = (r: Record<string, unknown>) =>
  ((r.content ?? []) as { type: string; text?: string }[]).map((c) => c.text ?? `[${c.type}]`).join("\n");

const MODELS = [
  { value: "fake-fast", name: "Fake Fast" },
  { value: "fake-smart", name: "Fake Smart" },
];
const MODES = [
  { value: "default", name: "Default" },
  { value: "yolo", name: "Yolo" },
];

function configOptions(s: FakeSession): acp.SessionConfigOption[] {
  return [
    { id: "model", name: "Model", category: "model", type: "select", currentValue: s.model, options: MODELS },
    { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: s.mode, options: MODES },
  ];
}

function systemPromptText(p: acp.SystemPrompt | null | undefined): string {
  return (p?.content ?? []).map((b) => (b.type === "text" ? b.text : "")).join("\n");
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

const app = acp
  .agent({ name: "fake-agent" })
  .onRequest("initialize", () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentInfo: { name: "fake-agent", title: "Fake Agent", version: "1.0.0" },
    agentCapabilities: {
      loadSession: false,
      promptCapabilities: { image: false, embeddedContext: false },
      mcpCapabilities: { http: !process.env.FAKE_ACP_NO_MCP_HTTP, sse: false },
      sessionCapabilities: {
        close: {},
        ...(process.env.FAKE_ACP_NO_RESUME ? {} : { resume: {} }),
        ...(process.env.FAKE_ACP_NO_SYSTEM_PROMPT ? {} : { systemPrompt: {} }),
      },
    },
    authMethods: [],
  }))
  .onRequest("session/new", async ({ params }) => {
    const slow = Number(process.env.FAKE_ACP_SLOW_SESSION ?? 0);
    if (slow) await Bun.sleep(slow);
    const sessionId = `fake-${crypto.randomUUID()}`;
    const s: FakeSession = {
      systemPrompt: systemPromptText(params.systemPrompt),
      model: "fake-fast",
      mode: "default",
      prompts: 0,
      mcpServers: params.mcpServers,
    };
    sessions.set(sessionId, s);
    save();
    return { sessionId, configOptions: configOptions(s) };
  })
  .onRequest("session/resume", ({ params }) => {
    const s = sessions.get(params.sessionId);
    if (!s) throw acp.RequestError.invalidParams({ sessionId: params.sessionId }, "unknown session");
    s.mcpServers = params.mcpServers ?? [];
    mcpClients.get(params.sessionId)?.close();
    mcpClients.delete(params.sessionId);
    return { configOptions: configOptions(s) };
  })
  .onRequest("session/close", ({ params }) => {
    sessions.delete(params.sessionId);
    save();
    return {};
  })
  .onRequest("session/set_config_option", ({ params }) => {
    const s = sessions.get(params.sessionId);
    if (!s) throw acp.RequestError.invalidParams({}, "unknown session");
    if (params.configId === "model") s.model = String(params.value);
    else if (params.configId === "mode") s.mode = String(params.value);
    else throw acp.RequestError.invalidParams({ configId: params.configId }, "unknown config option");
    save();
    return { configOptions: configOptions(s) };
  })
  .onNotification("session/cancel", ({ params }) => {
    running.get(params.sessionId)?.abort();
  })
  .onRequest("session/prompt", async ({ params, client }) => {
    const { sessionId } = params;
    const s = sessions.get(sessionId);
    if (!s) throw acp.RequestError.invalidParams({}, "unknown session");
    s.prompts++;
    save();
    const ac = new AbortController();
    running.set(sessionId, ac);
    const signal = ac.signal;
    const text = params.prompt
      .filter((b) => !(b.type === "text" && b.text.startsWith("<voice-call>")))
      .map((b) => (b.type === "text" ? b.text : `[${b.type}]`))
      .join("\n");
    const lower = text.toLowerCase();
    const update = (u: acp.SessionUpdate) => client.notify("session/update", { sessionId, update: u });
    const say = async (t: string, chunks = 3, delayMs = 15) => {
      const size = Math.ceil(t.length / chunks);
      for (let i = 0; i < t.length && !signal.aborted; i += size) {
        await update({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: t.slice(i, i + size) },
        });
        await sleep(delayMs, signal);
      }
    };
    const stop = (): acp.PromptResponse => ({ stopReason: signal.aborted ? "cancelled" : "end_turn" });

    try {
      await update({ sessionUpdate: "usage_update", used: 100, size: 200_000 });
      const call = /^mcp-(call|silent) (\S+)\s*(.*)$/s.exec(text.trim());
      const ping = /pingpong (\S+) (\S+)/.exec(text);
      if (call || ping) {
        const tool = call ? call[2]! : "send_message_to_agent";
        const args = call
          ? JSON.parse(call[3] || "{}")
          : { agent: ping![1], message: `pingpong ${ping![2]} ${ping![1]}` };
        const report = !call || call[1] === "call";
        const toolCallId = `mcp-${crypto.randomUUID()}`;
        if (report) {
          await update({
            sessionUpdate: "tool_call",
            toolCallId,
            title: `mcp__vibe__${tool}`,
            kind: "other",
            status: "pending",
            rawInput: args,
          });
        }
        const client = await mcpClient(sessionId, s);
        const r = await client.callTool({
          name: tool,
          arguments: args,
          _meta: { "claudecode/toolUseId": toolCallId },
        });
        const out = resultText(r);
        if (report) {
          await update({
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: r.isError ? "failed" : "completed",
            content: [{ type: "content", content: { type: "text", text: out } }],
          });
        }
        await say(`Result: ${out}`, 1);
        return stop();
      }
      if (lower.trim() === "mcp-list") {
        const client = await mcpClient(sessionId, s);
        const { tools } = await client.listTools();
        await say(`Tools: ${tools.map((t) => t.name).join(", ")}`, 1);
        return stop();
      }
      if (lower.includes("crash")) {
        await say("About to crash.", 1);
        process.exit(3);
      }
      if (lower.includes("hang")) {
        await new Promise(() => {}); // never resolves, ignores cancel
      }
      if (lower.includes("whoami")) {
        await say(`SYSTEM=[${s.systemPrompt}] MODEL=[${s.model}] MODE=[${s.mode}] PROMPT=[${text}]`, 2);
        return stop();
      }
      const printenv = /printenv (\w+)/.exec(text);
      if (printenv?.[1]) {
        await say(`${printenv[1]}=${process.env[printenv[1]] ?? ""}`, 1);
        return stop();
      }
      if (lower.includes("history")) {
        await say(`This session has seen ${s.prompts} prompts.`, 1);
        return stop();
      }
      if (lower.includes("slow")) {
        for (let i = 0; i < 40 && !signal.aborted; i++) {
          await update({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `chunk ${i}. ` },
          });
          await sleep(100, signal);
        }
        return stop();
      }
      if (lower.includes("thought")) {
        await update({
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "Let me think about it." },
        });
      }
      if (lower.includes("plan")) {
        await update({
          sessionUpdate: "plan",
          entries: [
            { content: "Read the code", priority: "high", status: "completed" },
            { content: "Write the fix", priority: "medium", status: "in_progress" },
          ],
        });
      }
      if (lower.includes("weather")) {
        await update({
          sessionUpdate: "tool_call",
          toolCallId: "weather-1",
          title: "Fetch weather",
          kind: "fetch",
          status: "in_progress",
        });
        await sleep(300, signal);
        await update({ sessionUpdate: "tool_call_update", toolCallId: "weather-1", status: "completed" });
        await say("It is sunny and warm.", 2);
        return stop();
      }
      if (lower.includes("tool")) {
        await say("Checking.", 1);
        await update({
          sessionUpdate: "tool_call",
          toolCallId: "tool-1",
          title: "Read README.md",
          kind: "read",
          status: "pending",
          rawInput: { path: "README.md" },
        });
        await sleep(30, signal);
        await update({ sessionUpdate: "tool_call_update", toolCallId: "tool-1", status: "in_progress" });
        await sleep(30, signal);
        await update({
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-1",
          status: "completed",
          content: [{ type: "content", content: { type: "text", text: "# Readme contents" } }],
        });
        await say("Done reading.", 1);
        return stop();
      }
      if (lower.includes("permission")) {
        const toolCall = {
          toolCallId: "tool-perm",
          title: "Run rm -rf build",
          kind: "execute",
          status: "pending",
          rawInput: { command: "rm -rf build" },
        } satisfies acp.ToolCall;
        await update({ sessionUpdate: "tool_call", ...toolCall });
        const res: acp.RequestPermissionResponse = await client.request("session/request_permission", {
          sessionId,
          toolCall,
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "deny", name: "Deny", kind: "reject_once" },
          ],
        });
        if (res.outcome.outcome === "cancelled") return { stopReason: "cancelled" };
        const allowed = res.outcome.optionId === "allow";
        await update({
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-perm",
          status: allowed ? "completed" : "failed",
        });
        await say(allowed ? "Permission granted, ran it." : "Permission denied, skipped it.", 1);
        return stop();
      }
      await say(`Echo: ${text}`);
      return stop();
    } finally {
      running.delete(sessionId);
    }
  });

app.connect(
  acp.ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  ),
);

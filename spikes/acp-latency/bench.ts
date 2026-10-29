// ACP latency harness: spawns one agent, opens one session, runs short voice-style turns
// and a barge-in, and writes timestamps to results/<config>-<ts>.json.
//
//   bun bench.ts <config-name> [--probe] [--turns N]
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, createWriteStream, existsSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { join, resolve } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { AFTER_BARGE_IN, BARGE_IN, CONFIGS, PERSONA, TURNS, type Config } from "./configs.ts";

const ROOT = import.meta.dir;
const now = () => performance.timeOrigin + performance.now(); // epoch ms, sub-ms resolution

const args = process.argv.slice(2);
const cfg: Config | undefined = CONFIGS[args[0] ?? ""];
if (!cfg) {
  console.error(`usage: bun bench.ts <${Object.keys(CONFIGS).join("|")}> [--probe] [--turns N]`);
  process.exit(1);
}
const probe = args.includes("--probe");
const turnLimit = args.includes("--turns") ? Number(args[args.indexOf("--turns") + 1]) : TURNS.length;

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runId = `${cfg.name}-${stamp}`;
const scratch = join(ROOT, "scratch", runId);
mkdirSync(scratch, { recursive: true });
mkdirSync(join(ROOT, "results"), { recursive: true });
const toolLog = join(scratch, ".tool-log.jsonl");
writeFileSync(toolLog, "");

// ---- per-agent setup ---------------------------------------------------------------------
let command: string[];
let sessionMeta: Record<string, unknown> | undefined;
if (cfg.agent === "claude") {
  // ADAPTER_RUNTIME=bun runs the adapter under Bun instead of its node shebang
  command = [process.env.ADAPTER_RUNTIME ?? "node", resolve(ROOT, "node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js")];
  sessionMeta = {
    systemPrompt: cfg.variant === "a" ? { append: PERSONA } : PERSONA,
    claudeCode: { options: { model: cfg.model, ...cfg.claudeOptions } },
  };
} else {
  command = ["opencode", "acp", "--print-logs", "--log-level", "INFO", "--cwd", scratch];
  if (cfg.variant === "a") {
    // default build agent + persona via project AGENTS.md
    writeFileSync(join(scratch, "AGENTS.md"), PERSONA + "\n");
  } else {
    // dedicated primary agent whose prompt replaces the default. Disabling built-in tools
    // (`tools: {x: false}`) makes the opencode free tier reject every request with "Free usage
    // limit reached" (see FINDINGS), so they stay defined and are only permission-denied.
    writeFileSync(
      join(scratch, "opencode.json"),
      JSON.stringify(
        {
          $schema: "https://opencode.ai/config.json",
          agent: {
            voice: {
              mode: "primary",
              description: "Voice manager persona",
              prompt: PERSONA,
              permission: { edit: "deny", bash: "deny", webfetch: "deny" },
            },
          },
        },
        null,
        2,
      ),
    );
  }
}

// ---- recording ----------------------------------------------------------------------------
type Ev = { t: number; kind: string; [k: string]: unknown };
interface Turn {
  idx: number | string;
  prompt: string;
  sentAt: number;
  events: Ev[];
  text: string;
  stopReason?: string;
  endAt?: number;
  error?: string;
}
let current: Turn | undefined;
const stray: Ev[] = []; // updates outside any turn

function record(update: acp.SessionUpdate) {
  const t = now();
  const ev: Ev = { t, kind: update.sessionUpdate };
  if (update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk") {
    const c = update.content;
    if (c.type === "text") (ev.len = c.text.length), (ev.text = c.text);
    if (update.sessionUpdate === "agent_message_chunk" && c.type === "text" && current) current.text += c.text;
  } else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
    ev.id = update.toolCallId;
    ev.status = update.status;
    ev.title = update.title;
  }
  if (current) current.events.push(ev);
  else stray.push(ev);
}

// ---- connection ---------------------------------------------------------------------------
const tSpawn = now();
const child = spawn(command[0]!, command.slice(1), {
  cwd: scratch,
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env },
});
const stderrLog = createWriteStream(join(scratch, "agent-stderr.log"));
child.stderr.pipe(stderrLog);
child.on("exit", (code, sig) => {
  if (!finished) console.error(`agent exited early: code=${code} sig=${sig} (see ${scratch}/agent-stderr.log)`);
});
let finished = false;

const permissionRequests: { t: number; title?: string | null }[] = [];
const app = acp
  .client({ name: "acp-latency-spike" })
  .onNotification("session/update", ({ params }) => record(params.update))
  .onRequest("session/request_permission", ({ params }) => {
    permissionRequests.push({ t: now(), title: params.toolCall.title });
    if (current) current.events.push({ t: now(), kind: "permission_request", title: params.toolCall.title });
    const opt =
      params.options.find((o) => o.kind === "allow_always") ?? params.options.find((o) => o.kind === "allow_once");
    return opt ? { outcome: { outcome: "selected", optionId: opt.optionId } } : { outcome: { outcome: "cancelled" } };
  });

const conn = app.connect(
  acp.ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  ),
);
const agent = conn.agent;

const init = await agent.request("initialize", {
  protocolVersion: acp.PROTOCOL_VERSION,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  clientInfo: { name: "acp-latency-spike", version: "0.0.1" },
});
const tInit = now();

const session = await agent.request("session/new", {
  cwd: scratch,
  mcpServers: [
    {
      name: "voice",
      command: process.execPath, // bun
      args: [join(ROOT, "mcp-server.ts")],
      env: [{ name: "TOOL_LOG", value: toolLog }],
    },
  ],
  ...(sessionMeta ? { _meta: sessionMeta } : {}),
});
const tSession = now();
const sessionId = session.sessionId;

// opencode: select model (and the voice agent for variant b) through ACP config options / modes
const configLog: unknown[] = [];
if (cfg.agent === "opencode") {
  const opts = (session as any).configOptions as any[] | undefined;
  const modelOpt = opts?.find((o) => o.id === "model" || o.category === "model");
  if (modelOpt) {
    const r = await agent.request("session/set_config_option", {
      sessionId,
      configId: modelOpt.id,
      value: cfg.model,
    } as any);
    configLog.push({ set: "model", value: cfg.model, ok: true, t: now() });
    void r;
  } else configLog.push({ set: "model", error: "no model config option" });
  if (cfg.variant === "b") {
    const modeOpt = opts?.find((o) => o.id === "mode" || o.category === "mode");
    if (modeOpt) {
      await agent.request("session/set_config_option", { sessionId, configId: modeOpt.id, value: "voice" } as any);
      configLog.push({ set: "mode", value: "voice", ok: true });
    } else {
      await agent.request("session/set_mode", { sessionId, modeId: "voice" });
      configLog.push({ set: "mode(session/set_mode)", value: "voice", ok: true });
    }
  }
}
const tReady = now();

if (probe) {
  console.log(JSON.stringify({ init, session }, null, 2));
}

// ---- turns --------------------------------------------------------------------------------
async function runTurn(idx: number | string, prompt: string, cancel?: { afterMs: number; afterFirstChunkMs?: number }) {
  const turn: Turn = { idx, prompt, sentAt: now(), events: [], text: "" };
  current = turn;
  let cancelAt: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const doCancel = () => {
    if (cancelAt) return;
    cancelAt = now();
    turn.events.push({ t: cancelAt, kind: "client_cancel_sent" });
    void agent.notify("session/cancel", { sessionId });
  };
  if (cancel) {
    timer = setTimeout(doCancel, cancel.afterMs);
    if (cancel.afterFirstChunkMs !== undefined) {
      const orig = turn.events.push.bind(turn.events);
      let armed = false;
      turn.events.push = (...e: Ev[]) => {
        const r = orig(...e);
        if (!armed && e.some((x) => x.kind === "agent_message_chunk")) {
          armed = true;
          setTimeout(doCancel, cancel.afterFirstChunkMs);
        }
        return r;
      };
    }
  }
  // opencode hangs forever on some provider errors (e.g. free-tier rate limit): give up after 45s
  const hang = setTimeout(() => {
    turn.error = "timeout: no prompt response after 45s";
    doCancel();
  }, 45_000);
  try {
    const res = await Promise.race([
      agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: prompt }] }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("abandoned: cancel did not resolve prompt")), 55_000)),
    ]);
    turn.stopReason = res.stopReason;
  } catch (e) {
    turn.error = String((e as Error)?.message ?? e);
  }
  turn.endAt = now();
  clearTimeout(hang);
  if (timer) clearTimeout(timer);
  // keep collecting stray chunks for a moment after a cancel to see whether output keeps flowing
  if (cancel) await new Promise((r) => setTimeout(r, 1500));
  current = undefined;
  const rel = (x?: number) => (x === undefined ? null : Math.round(x - turn.sentAt));
  const firstChunk = turn.events.find((e) => e.kind === "agent_message_chunk");
  console.log(
    `[${cfg!.name}] turn ${idx}: ttft=${rel(firstChunk?.t)}ms end=${rel(turn.endAt)}ms stop=${turn.stopReason ?? turn.error} :: ${turn.text.replace(/\s+/g, " ").slice(0, 160)}`,
  );
  return { ...turn, cancelAt };
}

const turns = [];
for (let i = 0; i < Math.min(turnLimit, TURNS.length); i++) {
  turns.push(await runTurn(i, TURNS[i]!));
  if (turns[0]!.error?.startsWith("timeout")) break; // provider dead (e.g. rate limit): don't burn 8 x 45s
}
let bargeIn, afterBargeIn;
if (!probe && !turns[0]!.error) {
  bargeIn = await runTurn("barge-in", BARGE_IN, { afterMs: 5000, afterFirstChunkMs: 300 });
  afterBargeIn = await runTurn("after-barge-in", AFTER_BARGE_IN);
}

// ---- output -------------------------------------------------------------------------------
finished = true;
const toolEvents = existsSync(toolLog)
  ? readFileSync(toolLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
  : [];
const out = {
  config: cfg,
  runId,
  command,
  cold: {
    spawnToInitMs: tInit - tSpawn,
    initToSessionMs: tSession - tInit,
    sessionToReadyMs: tReady - tSession,
    spawnToReadyMs: tReady - tSpawn,
  },
  t: { spawn: tSpawn, init: tInit, session: tSession, ready: tReady },
  agentInfo: (init as any).agentInfo,
  configLog,
  sessionConfigOptions: (session as any).configOptions?.map((o: any) => ({ id: o.id, currentValue: o.currentValue })),
  turns,
  bargeIn,
  afterBargeIn,
  toolEvents,
  permissionRequests,
  stray,
};
const outFile = join(ROOT, "results", `${runId}.json`);
writeFileSync(outFile, JSON.stringify(out, null, 2));
console.log(`wrote ${outFile}`);
conn.close();
child.kill("SIGTERM");
setTimeout(() => process.exit(0), 500);

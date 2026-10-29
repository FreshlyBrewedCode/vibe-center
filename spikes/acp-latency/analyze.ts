// Summarise results/*.json into per-config latency tables (markdown on stdout).
//   bun analyze.ts [results-dir]   -> also writes results/summary.json
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] ?? join(import.meta.dir, "results");
type Ev = { t: number; kind: string; text?: string; len?: number; id?: string; status?: string; title?: string };

const SENTENCE = /[.!?](\s|$)/;
const CONTENT = new Set(["agent_message_chunk", "agent_thought_chunk", "tool_call"]);

function turnMetrics(turn: any, toolEvents: any[]) {
  const s = turn.sentAt as number;
  const ev: Ev[] = turn.events;
  const rel = (t?: number) => (t === undefined ? undefined : t - s);
  const chunks = ev.filter((e) => e.kind === "agent_message_chunk");
  let acc = "";
  let firstSentence: number | undefined;
  for (const c of chunks) {
    acc += c.text ?? "";
    if (firstSentence === undefined && SENTENCE.test(acc)) firstSentence = c.t;
  }
  if (firstSentence === undefined && chunks.length) firstSentence = turn.endAt; // whole reply is one sentence

  // tool calls: ACP announce -> MCP server invoked -> ACP completed -> next text chunk (model resumes)
  const tools: any[] = [];
  for (const e of ev.filter((e) => e.kind === "tool_call")) {
    const done = ev.find((x) => x.kind === "tool_call_update" && x.id === e.id && (x.status === "completed" || x.status === "failed"));
    const voiceTool = ["list_sessions", "dispatch_task"].find((n) => e.title?.includes(n));
    const mcp = voiceTool && toolEvents.find((m) => m.tool === voiceTool && m.phase === "start" && m.t >= e.t - 5 && m.t <= (done?.t ?? Infinity) + 5);
    const mcpEnd = mcp && toolEvents.find((m) => m.phase === "end" && m.t >= mcp.t);
    const resume = done && chunks.find((c) => c.t > done.t);
    const textBefore = chunks.some((c) => c.t < e.t);
    tools.push({
      title: e.title,
      voiceTool: !!voiceTool,
      announceMs: rel(e.t),
      announceToMcpMs: mcp ? mcp.t - e.t : undefined,
      mcpToCompletedMs: mcpEnd && done ? done.t - mcpEnd.t : undefined,
      completedToResumeMs: resume && done ? resume.t - done.t : undefined,
      announceToResumeMs: resume ? resume.t - e.t : undefined,
      spokeBeforeTool: textBefore,
      status: done?.status,
    });
  }
  const gaps = chunks.slice(1).map((c, i) => c.t - chunks[i]!.t);
  return {
    idx: turn.idx,
    firstUpdate: rel(ev[0]?.t),
    firstUpdateKind: ev[0]?.kind,
    firstContent: rel(ev.find((e) => CONTENT.has(e.kind))?.t),
    ttft: rel(chunks[0]?.t),
    firstSentence: rel(firstSentence),
    end: rel(turn.endAt),
    chars: turn.text.length,
    chunks: chunks.length,
    maxGap: gaps.length ? Math.max(...gaps) : 0,
    thoughtChunks: ev.filter((e) => e.kind === "agent_thought_chunk").length,
    tools,
    stopReason: turn.stopReason,
    error: turn.error,
    text: turn.text,
  };
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return undefined;
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.ceil((p / 100) * a.length) - 1)];
};
const f = (x?: number) => (x === undefined || Number.isNaN(x) ? "–" : String(Math.round(x)));

const runs = readdirSync(dir)
  .filter((n) => n.endsWith(".json") && n !== "summary.json")
  .map((n) => JSON.parse(readFileSync(join(dir, n), "utf8")))
  .filter((r) => !r.probe && r.turns?.length > 1);

const summary: any[] = [];
const byConfig = new Map<string, any[]>();
for (const r of runs) {
  const turns = r.turns.map((t: any) => turnMetrics(t, r.toolEvents));
  const barge = r.bargeIn && {
    ...turnMetrics(r.bargeIn, r.toolEvents),
    cancelSentMs: r.bargeIn.cancelAt ? r.bargeIn.cancelAt - r.bargeIn.sentAt : undefined,
    cancelToResolveMs: r.bargeIn.cancelAt ? r.bargeIn.endAt - r.bargeIn.cancelAt : undefined,
    lastChunkAfterCancelMs: (() => {
      const after = r.bargeIn.events.filter((e: Ev) => e.kind === "agent_message_chunk" && e.t > r.bargeIn.cancelAt);
      return after.length ? after.at(-1).t - r.bargeIn.cancelAt : 0;
    })(),
    chunksAfterCancel: r.bargeIn.events.filter((e: Ev) => e.kind === "agent_message_chunk" && e.t > r.bargeIn.cancelAt).length,
    eventsAfterResolve: r.bargeIn.events.filter((e: Ev) => e.t > r.bargeIn.endAt).map((e: Ev) => e.kind),
  };
  const after = r.afterBargeIn && turnMetrics(r.afterBargeIn, r.toolEvents);
  const s = { config: r.config.name, runId: r.runId, cold: r.cold, turns, barge, after };
  summary.push(s);
  byConfig.set(r.config.name, [...(byConfig.get(r.config.name) ?? []), s]);
}
writeFileSync(join(dir, "summary.json"), JSON.stringify(summary, null, 2));

const out: string[] = [];
for (const [name, rs] of byConfig) {
  out.push(`\n### ${name} (${rs.length} run${rs.length > 1 ? "s" : ""})\n`);
  out.push("| run | spawn→init | init→session | ready | turn-0 TTFT | turn-0 1st sentence | turn-0 end |");
  out.push("|---|---|---|---|---|---|---|");
  for (const r of rs) {
    const t0 = r.turns[0];
    out.push(
      `| ${r.runId.slice(-24, -5)} | ${f(r.cold.spawnToInitMs)} | ${f(r.cold.initToSessionMs)} | ${f(r.cold.spawnToReadyMs)} | ${f(t0.ttft)} | ${f(t0.firstSentence)} | ${f(t0.end)} |`,
    );
  }
  const warm = rs.flatMap((r) => r.turns.slice(1)).filter((t: any) => !t.error);
  const warmNoTool = warm.filter((t: any) => !t.tools.length);
  const warmTool = warm.filter((t: any) => t.tools.length);
  const row = (label: string, ts: any[], key: string) => {
    const xs = ts.map((t) => t[key]).filter((x) => typeof x === "number");
    return `| ${label} | ${ts.length} | ${f(pct(xs, 50))} | ${f(pct(xs, 90))} | ${f(Math.min(...xs))} | ${f(Math.max(...xs))} |`;
  };
  out.push("\nWarm turns (turn 1..N, ms after `session/prompt`):\n");
  out.push("| metric | n | median | p90 | min | max |");
  out.push("|---|---|---|---|---|---|");
  out.push(row("first update (any)", warm, "firstUpdate"));
  out.push(row("first content update", warm, "firstContent"));
  out.push(row("TTFT (all warm)", warm, "ttft"));
  out.push(row("first sentence (all warm)", warm, "firstSentence"));
  out.push(row("turn end (all warm)", warm, "end"));
  out.push(row("TTFT (no-tool turns)", warmNoTool, "ttft"));
  out.push(row("turn end (no-tool turns)", warmNoTool, "end"));
  out.push(row("TTFT (tool turns)", warmTool, "ttft"));
  out.push(row("turn end (tool turns)", warmTool, "end"));
  const allTools = rs.flatMap((r) => r.turns.flatMap((t: any) => t.tools));
  const tools = allTools.filter((t: any) => t.voiceTool);
  const otherTools = allTools.filter((t: any) => !t.voiceTool).map((t: any) => t.title);
  const trow = (label: string, key: string) => {
    const xs = tools.map((t: any) => t[key]).filter((x: any) => typeof x === "number");
    return `| ${label} | ${xs.length} | ${f(pct(xs, 50))} | ${f(pct(xs, 90))} | ${f(Math.min(...xs))} | ${f(Math.max(...xs))} |`;
  };
  out.push(trow("tool: ACP announce → MCP invoked", "announceToMcpMs"));
  out.push(trow("tool: MCP returned → ACP completed", "mcpToCompletedMs"));
  out.push(trow("tool: completed → next text chunk", "completedToResumeMs"));
  out.push(trow("tool: announce → next text chunk", "announceToResumeMs"));
  const spoke = tools.filter((t: any) => t.spokeBeforeTool).length;
  out.push(`\nVoice tool calls: ${tools.length} (${spoke} preceded by spoken text). Other tool calls: ${otherTools.length ? otherTools.join(", ") : "none"}. Chars/turn median ${f(pct(warm.map((t: any) => t.chars), 50))}. Max inter-chunk gap median ${f(pct(warm.map((t: any) => t.maxGap), 50))} ms; chunks/turn median ${f(pct(warm.map((t: any) => t.chunks), 50))}; thought chunks total ${warm.reduce((a: number, t: any) => a + t.thoughtChunks, 0)}.`);
  const errs = rs.flatMap((r) => r.turns.filter((t: any) => t.error).map((t: any) => `turn ${t.idx}: ${t.error}`));
  if (errs.length) out.push(`\nErrors: ${errs.join("; ")}`);
  out.push("\nBarge-in:\n");
  out.push("| run | cancel sent at | cancel→prompt resolved | last chunk after cancel | chunks after cancel | stopReason | next turn TTFT | next turn end |");
  out.push("|---|---|---|---|---|---|---|---|");
  for (const r of rs) {
    const b = r.barge;
    if (!b) continue;
    out.push(
      `| ${r.runId.slice(-24, -5)} | ${f(b.cancelSentMs)} ${b.ttft !== undefined && b.ttft < (b.cancelSentMs ?? 0) ? `(1st chunk @${f(b.ttft)})` : "(before any text)"} | ${f(b.cancelToResolveMs)} | ${f(b.lastChunkAfterCancelMs)} | ${b.chunksAfterCancel} | ${b.stopReason ?? b.error} | ${f(r.after?.ttft)} | ${f(r.after?.end)} |`,
    );
  }
}
console.log(out.join("\n"));

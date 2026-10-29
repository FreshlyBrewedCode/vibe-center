// Reference: cold per-call cost of one-shot `claude -p` with partial-message streaming.
//   bun claude-p.ts [runs=3] [model=haiku]
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const runs = Number(process.argv[2] ?? 3);
const model = process.argv[3] ?? "haiku";
const scratch = join(import.meta.dir, "scratch", "claude-p");
mkdirSync(scratch, { recursive: true });
const now = () => performance.timeOrigin + performance.now();
const prompt = "Hey, what's up? Answer in one or two short spoken sentences, no markdown.";

const results = [];
for (let i = 0; i < runs; i++) {
  const t0 = now();
  const child = spawn(
    "claude",
    ["-p", "--model", model, "--output-format", "stream-json", "--include-partial-messages", "--verbose", prompt],
    { cwd: scratch, stdio: ["ignore", "pipe", "inherit"] },
  );
  const r: Record<string, number | string | undefined> = { model };
  let text = "";
  for await (const line of createInterface({ input: child.stdout })) {
    const t = now() - t0;
    let m: any;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    r.firstLineMs ??= t;
    if (m.type === "system" && m.subtype === "init") r.initMs ??= t;
    const d = m.type === "stream_event" ? m.event : undefined;
    if (d?.type === "message_start") r.messageStartMs ??= t;
    if (d?.type === "content_block_delta" && d.delta?.type === "text_delta") {
      r.ttftMs ??= t;
      text += d.delta.text;
      if (r.firstSentenceMs === undefined && /[.!?](\s|$)/.test(text)) r.firstSentenceMs = t;
    }
    if (m.type === "result") (r.resultMs = t), (r.apiMs = m.duration_api_ms);
  }
  r.exitMs = now() - t0;
  r.text = text;
  console.log(JSON.stringify(r));
  results.push(r);
}
const out = join(import.meta.dir, "results", `claude-p-${model}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(out, JSON.stringify(results, null, 2));
console.log(`wrote ${out}`);

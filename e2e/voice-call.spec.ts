import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Browser, chromium, expect, test } from "@playwright/test";
import type {
  AgentView,
  Call,
  Harness,
  Message,
  MessagesResponse,
  VoiceStatus,
} from "../packages/shared/src/index.ts";

// A whole voice call through the real app: the managed Python worker (services/voice), WebRTC
// from headless Chromium whose microphone plays a scripted WAV (services/voice/tests/scenario.py),
// signalling through the app, the bridge into the agent's session. The agent is the fake ACP
// agent by default (deterministic, instant replies: the latency is the pipeline's own); set
// VC_E2E_VOICE_AGENT=claude for Claude Code on Haiku (real agent latency, costs a few requests).
// Speech uses whatever the voice settings point at: the GPU servers if `speech.sh up` ran,
// else the worker's CPU fallbacks. Skip with VC_E2E_VOICE=0.

const ROOT = join(import.meta.dirname, "..");
const VOICE = join(ROOT, "services/voice");
const FAKE_AGENT = join(ROOT, "packages/server/test/fake-agent.ts");
const dataDir = process.env.VC_E2E_DATA_DIR!;
const OUT = join(ROOT, "test-results/voice");
const realAgent = process.env.VC_E2E_VOICE_AGENT === "claude";
const chromiumPath =
  process.env.VC_E2E_CHROMIUM ??
  (existsSync(join(ROOT, ".chromium/bin/chromium")) ? join(ROOT, ".chromium/bin/chromium") : undefined);

test.skip(process.env.VC_E2E_VOICE === "0", "voice e2e disabled (VC_E2E_VOICE=0)");

interface Scenario {
  wav: string;
  duration: number;
  timeline: { id: string; start: number; end?: number; text: string }[];
}

function mintLink(): string {
  const out = execFileSync("bun", ["packages/server/src/cli.ts", "link", "--data-dir", dataDir], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const m = /(http:\/\/localhost:\d+\/login#token=\S+)/.exec(out);
  if (!m?.[1]) throw new Error(`no link in output:\n${out}`);
  return m[1];
}

/** Records when the page's mic and the agent's audio are audible (same clock as the server). */
function audioProbe() {
  type Seg = { src: string; on: number; off: number | null };
  const w = window as unknown as { __vcAudio: Seg[] };
  const rec: Seg[] = [];
  w.__vcAudio = rec;
  const watch = (stream: MediaStream, src: string) => {
    const ctx = new AudioContext();
    const an = ctx.createAnalyser();
    an.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Float32Array(an.fftSize);
    let seg: Seg | null = null;
    let last = 0;
    setInterval(() => {
      an.getFloatTimeDomainData(buf);
      let s = 0;
      for (const v of buf) s += v * v;
      const t = performance.timeOrigin + performance.now();
      if (Math.sqrt(s / buf.length) > 0.01) {
        last = t;
        if (!seg) {
          seg = { src, on: t, off: null };
          rec.push(seg);
        }
      } else if (seg && t - last > 150) {
        seg.off = last;
        seg = null;
      }
    }, 10);
  };
  const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (c) => {
    const s = await gum(c);
    watch(s, "mic");
    return s;
  };
  const PC = window.RTCPeerConnection;
  window.RTCPeerConnection = class extends PC {
    constructor(...args: ConstructorParameters<typeof RTCPeerConnection>) {
      super(...args);
      this.addEventListener("track", (e) => watch(e.streams[0] ?? new MediaStream([e.track]), "bot"));
    }
  };
}

let browser: Browser;
let scenario: Scenario;

test.beforeAll(async () => {
  mkdirSync(OUT, { recursive: true });
  // the user's side of the call, synthesized once (local Kokoro, a male voice) and cached
  const out = execFileSync(
    join(VOICE, "run.sh"),
    ["python", "-m", "tests.make_audio", "--out", join(VOICE, "tests/out")],
    {
      cwd: VOICE,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  scenario = JSON.parse(out.trim().split("\n").at(-1)!) as Scenario;
  browser = await chromium.launch({
    executablePath: chromiumPath,
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${scenario.wav}%noloop`,
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
});

test.afterAll(async () => {
  await browser?.close();
});

test("call an agent: transcripts in the DM, tool filler, barge-in, proactive event, hang up", async () => {
  test.setTimeout(300_000);
  const context = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
    permissions: ["microphone"],
  });
  await context.addInitScript(audioProbe);
  const page = await context.newPage();
  page.on("console", (m) => m.type() === "error" && console.log(`[browser] ${m.text()}`));
  await page.goto(mintLink());
  await expect(page.getByRole("link", { name: "New agent" }).first()).toBeVisible();

  // the managed worker loads its models in the background after the app starts
  await expect
    .poll(
      async () => ((await (await page.request.get("/api/voice/status")).json()) as VoiceStatus).worker.state,
      {
        timeout: 180_000,
        intervals: [1000],
      },
    )
    .toBe("ok");
  const status = (await (await page.request.get("/api/voice/status")).json()) as VoiceStatus;
  console.log(`speech: STT ${status.stt.url} ${status.stt.state}, TTS ${status.tts.url} ${status.tts.state}`);

  let harnessId = "claude-code";
  if (!realAgent) {
    const h = (await (
      await page.request.post("/api/harnesses", {
        data: { name: "Fake", command: "bun", args: [FAKE_AGENT] },
      })
    ).json()) as Harness;
    harnessId = h.id;
  }
  const agent = (await (
    await page.request.post("/api/agents", {
      data: {
        name: "Vox",
        avatar: { emoji: "🎙️", color: "#7c3aed" },
        systemPrompt: realAgent
          ? "You are Vox, a friendly assistant. For the weather, run `date` with Bash and say it is sunny. Keep answers short."
          : "",
        harnessId,
        model: realAgent ? "haiku" : null,
        options: realAgent ? { mode: "bypassPermissions" } : {},
        cwd: dataDir,
        voice: "af_heart",
      },
    })
  ).json()) as AgentView;

  // The agent editor offers the TTS voices, with a preview.
  await page.goto(`/agents/${agent.id}/edit`);
  await page.getByRole("combobox", { name: "Voice" }).click();
  await expect(page.getByRole("option", { name: "George" })).toBeVisible();
  await page.keyboard.press("Escape");
  const preview = page.waitForResponse((r) => r.url().endsWith("/api/voice/preview"));
  await page.getByRole("button", { name: "Preview voice" }).click();
  expect((await preview).headers()["content-type"]).toBe("audio/wav");

  // Call from the DM header. The fake mic starts playing the scenario at getUserMedia.
  await page.goto(`/agents/${agent.id}`);
  const t0 = Date.now();
  await page.getByTestId("call-button").click();
  await expect(page.getByTestId("call-state")).toHaveText(/Listening|Thinking|Speaking/, { timeout: 30_000 });
  await expect(page.getByTestId("presence")).toContainText("In a call");
  await expect(page.getByTestId("call-timer")).toBeVisible();
  const [call] = (await (await page.request.get("/api/voice/calls")).json()) as Call[];
  expect(call?.agentId).toBe(agent.id);

  // Play the scenario; inject the proactive event at its slot (spoken when the line is quiet).
  const ev = scenario.timeline.find((x) => x.id === "event")!;
  await page.waitForTimeout(Math.max(0, t0 + ev.start * 1000 - Date.now()));
  expect(
    (await page.request.post(`/api/voice/calls/${call!.id}/event`, { data: { text: ev.text } })).ok(),
  ).toBe(true);
  await page.waitForTimeout(Math.max(0, t0 + (scenario.duration + 6) * 1000 - Date.now()));

  // Both sides are in the DM as voice transcripts; tool calls show as usual.
  const { messages } = (await (
    await page.request.get(`/api/conversations/${agent.conversationId}/messages`)
  ).json()) as MessagesResponse;
  const said = messages.filter((m) => m.kind === "voice_transcript" && m.role === "user").map((m) => m.text);
  const replies = messages.filter((m) => m.kind === "voice_transcript" && m.role === "agent");
  console.log(`user said:\n  ${said.join("\n  ")}`);
  console.log(`agent:\n  ${replies.map((m) => `[${m.status}] ${m.text.slice(0, 80)}`).join("\n  ")}`);
  expect(said.length).toBeGreaterThanOrEqual(4);
  expect(said.join(" ").toLowerCase()).toContain("weather");
  expect(replies.filter((m) => m.status === "complete").length).toBeGreaterThanOrEqual(3);
  expect(messages.some((m) => m.kind === "tool_call")).toBe(true);
  // barge-in: the fake agent's slow story is still streaming when the next utterance starts, so
  // its turn is cancelled (a real agent has usually finished writing: then only the audio stops)
  if (!realAgent) expect(replies.some((m: Message) => m.status === "cancelled")).toBe(true);
  // the proactive event was prompted (and answered by voice)
  const event = messages.find((m) => m.kind === "text" && m.data?.source === "event");
  expect(event?.text).toBe(ev.text);
  await expect(
    page
      .getByTestId("message-user")
      .filter({ hasText: /weather/i })
      .first(),
  ).toBeVisible();
  await expect(page.getByTestId("call-transcript")).toBeVisible();
  await page.screenshot({ path: join(OUT, "call.png") });

  // Hang up: the bar goes away and the agent is idle again.
  const browserAudio = await page.evaluate(() => (window as unknown as { __vcAudio: unknown[] }).__vcAudio);
  await page.getByTestId("call-hangup").click();
  await expect(page.getByTestId("call-bar")).toHaveCount(0);
  await expect(page.getByTestId("presence")).toHaveText("Idle", { timeout: 10_000 });
  expect(await (await page.request.get("/api/voice/calls")).json()).toEqual([]);

  // Latency report from the worker's call log, joined with the page's own audio onsets.
  const logs = join(dataDir, "voice", "calls");
  const log = readdirSync(logs)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => join(logs, f))
    .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs)
    .at(-1)!;
  const browserJson = join(OUT, "browser.json");
  writeFileSync(browserJson, JSON.stringify({ audio: browserAudio }));
  const report = execFileSync(
    join(VOICE, "run.sh"),
    ["python", "-m", "voice_worker.analyze", log, "--browser", browserJson],
    {
      cwd: VOICE,
      encoding: "utf8",
    },
  );
  const tag = `${realAgent ? "claude" : "fake"}-${status.stt.state === "ok" ? "gpu" : "cpu"}`;
  writeFileSync(join(OUT, `latency-${tag}.txt`), report);
  writeFileSync(join(OUT, `call-${tag}.jsonl`), readFileSync(log));
  writeFileSync(join(OUT, `browser-${tag}.json`), JSON.stringify({ audio: browserAudio }));
  console.log(report);
  // the agent's first audio left the worker for most user turns; the user talked over it once
  const turns = readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { kind: string; t: Record<string, number>; barge_in_while?: string });
  expect(turns.filter((r) => r.kind === "user" && r.t.first_audio_out).length).toBeGreaterThanOrEqual(3);
  expect(turns.some((r) => r.barge_in_while)).toBe(true);
  await context.close();
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentView,
  Call,
  Harness,
  MessagesResponse,
  ServerEvent,
  StartCallResponse,
  VoiceSettings,
  VoiceStatus,
} from "@vibe-center/shared";
import { type AppServer, createServer } from "../src/server.ts";

// Phase 2b: the app's voice layer against a fake worker (same API and bridge protocol as
// services/voice, no audio) and the fake ACP agent.
const FAKE_AGENT = join(import.meta.dir, "fake-agent.ts");
const FAKE_WORKER = join(import.meta.dir, "fake-voice-worker.ts");

let app: AppServer;
let base: string;
let cookie = "";
let dataDir: string;

async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const res = await raw(path, init);
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${res.status} ${await res.text()}`);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

function raw(path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (cookie) headers.set("cookie", cookie);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  return fetch(`${base}${path}`, {
    ...init,
    headers,
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
  });
}

async function until<T>(fn: () => Promise<T | null | undefined | false>, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(50);
  }
}

function events() {
  const seen: ServerEvent[] = [];
  const ws = new WebSocket(`${base.replace("http", "ws")}/ws`, { headers: { cookie } } as never);
  ws.onmessage = (m) => seen.push(JSON.parse(String(m.data)) as ServerEvent);
  const opened = new Promise<void>((r) => {
    ws.onopen = () => r();
  });
  const find = <E extends ServerEvent>(pred: (e: ServerEvent) => boolean) =>
    until(async () => seen.find(pred) as E | undefined);
  return { ws, seen, opened, find };
}

const status = () => api<VoiceStatus>("/api/voice/status");
/** The fake worker's test endpoints (unauthenticated, on the worker's loopback port). */
async function worker<T = unknown>(path: string, json?: unknown): Promise<T> {
  const url = (await status()).worker.url!;
  const res = await fetch(`${url}${path}`, {
    method: json === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  return (await res.json()) as T;
}
type Frame = { type: string; id?: string; text?: string; status?: string; title?: string; reason?: string };
const callNow = async () => (await api<Call[]>("/api/voice/calls"))[0];
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const frames = () => worker<Frame[]>("/test/frames");
const messages = async (agent: AgentView) =>
  (await api<MessagesResponse>(`/api/conversations/${agent.conversationId}/messages`)).messages;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "vc-voice-"));
  app = createServer({
    dataDir,
    port: 0,
    webDist: null,
    timeouts: { idleMs: 3000, cancelGraceMs: 500 },
    voice: {
      autostart: true,
      workerCommand: [process.execPath, FAKE_WORKER],
      healthIntervalMs: 200,
      restartDelayMs: 100,
      gpuSpeechScript: null,
    },
  });
  base = `http://127.0.0.1:${app.port}`;
  const token = app.services.auth.mintLinkToken();
  const res = await fetch(`${base}/api/auth/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  cookie = res.headers.get("set-cookie")!.split(";")[0]!;
});

afterAll(async () => {
  await app.stop();
});

describe("managed voice worker", () => {
  test("starts with the app and reports healthy", async () => {
    const s = await until(async () => {
      const s = await status();
      return s.worker.state === "ok" && s;
    });
    expect(s.worker.mode).toBe("managed");
    expect(s.worker.version).toBe("fake");
    expect(s.worker.pid).toBeGreaterThan(0);
    expect(s.worker.logTail.join("\n")).toContain("fake voice worker on");
  });

  test("an unreachable STT server is reported down, with the CPU fallback", async () => {
    await api("/api/voice/settings", { method: "PATCH", json: { sttUrl: "http://127.0.0.1:1" } });
    const s = await status();
    expect(s.stt).toMatchObject({ state: "down", url: "http://127.0.0.1:1" });
    expect(s.stt.message).toContain("CPU");
  });

  test("is restarted after a crash, and logged", async () => {
    const before = await status();
    await worker("/test/crash", {});
    await until(async () => (await status()).worker.state === "error");
    const after = await until(async () => {
      const s = await status();
      return s.worker.state === "ok" && s.worker.restarts === 1 && s;
    });
    expect(after.worker.pid).not.toBe(before.worker.pid);
    const log = readFileSync(join(dataDir, "logs", "voice-worker.log"), "utf8");
    expect(log).toContain("voice worker exited (exit code 1)");
  });

  test("settings: defaults, validation, write-only token, CPU-only STT", async () => {
    const s = await api<VoiceSettings>("/api/voice/settings");
    expect(s).toMatchObject({ workerMode: "managed", ttsUrl: "http://127.0.0.1:8402", filler: true });
    const bad = await raw("/api/voice/settings", { method: "PATCH", json: { sttUrl: "not a url" } });
    expect(bad.status).toBe(400);
    const next = await api<VoiceSettings>("/api/voice/settings", {
      method: "PATCH",
      json: { sttUrl: "", workerToken: "secret", filler: false },
    });
    expect(next).toMatchObject({
      sttUrl: "",
      workerTokenSet: true,
      filler: false,
      ttsUrl: "http://127.0.0.1:8402",
    });
    expect(JSON.stringify(next)).not.toContain("secret");
    expect((await status()).stt.state).toBe("off");
    await api("/api/voice/settings", { method: "PATCH", json: { filler: true } });
  });

  test("voices and preview go through the worker", async () => {
    const v = await api<{ voices: string[] }>("/api/voice/voices");
    expect(v.voices).toContain("bm_george");
    const res = await raw("/api/voice/preview", { method: "POST", json: { voice: "bm_george" } });
    expect(res.headers.get("content-type")).toBe("audio/wav");
  });
});

describe("a call through the bridge", () => {
  let agent: AgentView;
  let call: Call;

  test("start: signalling is proxied, the worker dials the bridge, presence is in call", async () => {
    const fake = await api<Harness>("/api/harnesses", {
      method: "POST",
      json: { name: "Fake", command: process.execPath, args: [FAKE_AGENT] },
    });
    agent = await api<AgentView>("/api/agents", {
      method: "POST",
      json: {
        name: "Echo",
        avatar: { emoji: "🦜", color: "#22aa88" },
        harnessId: fake.id,
        cwd: dataDir,
        voice: "bm_george",
      },
    });
    const ev = events();
    await ev.opened;
    const res = await api<StartCallResponse>("/api/voice/calls", {
      method: "POST",
      json: { agentId: agent.id, sdp: "v=0 offer", type: "offer" },
    });
    call = res.call;
    expect(res.answer).toEqual({ sdp: "v=0 fake-answer", type: "answer", pcId: "pc-1" });
    expect(res.call.speech).toEqual({ stt: "cpu", tts: "cpu" });
    const reqs = await worker<{ path: string; body: Record<string, unknown> }[]>("/test/requests");
    const started = reqs.find((r) => r.path === "/calls")!.body;
    expect(started).toMatchObject({ call_id: call.id, voice: "bm_george", filler: true, agent_name: "Echo" });
    expect(String(started.bridge_url)).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/voice\/bridge$/);
    expect((await frames())[0]).toMatchObject({ type: "hello", callId: call.id, agentName: "Echo" });
    // the worker reported "listening": presence and call state follow
    await ev.find((e) => e.type === "call.upsert" && e.call.state === "listening");
    await ev.find((e) => e.type === "agent.presence" && e.presence === "in_call" && e.detail === "listening");
    expect((await api<Call[]>("/api/voice/calls")).map((c) => c.id)).toEqual([call.id]);
    ev.ws.close();
  });

  test("the bridge refuses a wrong or reused credential", async () => {
    const res = await fetch(`${base}/voice/bridge`, {
      headers: { authorization: "Bearer nope", upgrade: "websocket", connection: "upgrade" },
    });
    expect(res.status).toBe(401);
  });

  test("an utterance is prompted into the agent's session; both sides land as voice transcripts", async () => {
    const { id } = await worker<{ id: string }>("/test/say", { text: "hello by voice" });
    const done = await until(async () => (await frames()).find((f) => f.type === "done" && f.id === id));
    expect(done.status).toBe("complete");
    const mine = (await frames()).filter((f) => f.id === id);
    expect(mine.map((f) => f.type)).toEqual(expect.arrayContaining(["started", "usage", "text", "done"]));
    // the voice-mode note went to the agent but is not echoed (the fake strips <voice-call>)
    expect(
      mine
        .filter((f) => f.type === "text")
        .map((f) => f.text)
        .join(""),
    ).toBe("Echo: hello by voice");
    const ms = await messages(agent);
    expect(ms.map((m) => `${m.role}:${m.kind}:${m.text}`)).toEqual([
      "user:voice_transcript:hello by voice",
      "agent:voice_transcript:Echo: hello by voice",
    ]);
    expect(ms[0]?.data).toMatchObject({ source: "voice" });
  });

  test("a barge-in after the reply already finished marks it interrupted, not cancelled", async () => {
    const { id } = await worker<{ id: string }>("/test/say", { text: "a short one" });
    await until(async () => (await frames()).find((f) => f.type === "done" && f.id === id));
    const reply = (await messages(agent)).at(-1)!;
    expect(reply.status).toBe("complete");
    await worker("/test/interrupted", { id });
    const interrupted = await until(async () => {
      const m = (await messages(agent)).find((mm) => mm.id === reply.id);
      return m?.data && "interrupted" in m.data && m.data.interrupted ? m : null;
    });
    expect(interrupted.status).toBe("complete"); // the reply itself is unchanged, just flagged
  });

  test("a silent tool call reaches the worker as a tool frame (the filler trigger)", async () => {
    const { id } = await worker<{ id: string }>("/test/say", { text: "what's the weather" });
    await until(async () => (await frames()).find((f) => f.type === "done" && f.id === id));
    const mine = (await frames()).filter((f) => f.id === id && (f.type === "tool" || f.type === "text"));
    expect(mine[0]).toMatchObject({ type: "tool", status: "start", title: "Fetch weather" });
    expect(mine.map((f) => f.type)).toContain("text");
    const tool = (await messages(agent)).find((m) => m.kind === "tool_call");
    expect(tool?.text).toBe("Fetch weather");
  });

  test("barge-in cancels only that turn", async () => {
    const { id } = await worker<{ id: string }>("/test/say", { text: "tell me something slow" });
    await until(async () => (await frames()).find((f) => f.type === "text" && f.id === id));
    await worker("/test/cancel", { id });
    const done = await until(async () => (await frames()).find((f) => f.type === "done" && f.id === id));
    expect(done.status).toBe("cancelled");
    const reply = (await messages(agent)).at(-1)!;
    expect(reply.status).toBe("cancelled");
    expect(reply.text).not.toContain("chunk 39.");
    // context (e.g. the cancelled words) travels in the hidden note, the DM shows just the words
    const next = await worker<{ id: string }>("/test/say", {
      text: "whoami",
      context: "(This continues my previous message.)",
    });
    await until(async () => (await frames()).find((f) => f.type === "done" && f.id === next.id));
    expect((await messages(agent)).at(-2)?.text).toBe("whoami");
  });

  test("proactive events: the speakEvent hook, then an event turn", async () => {
    expect(app.services.voice.speakEvent("nobody", "x")).toBe(false);
    const prompted: string[] = [];
    const sent = app.services.voice.speakEvent(agent.id, "the build finished", {
      note: "[Reply from the agent Builder]",
      fromAgentId: agent.id,
      onPrompt: (h) => prompted.push(h.turnId),
    });
    expect(sent).toBe(true);
    await until(async () =>
      (await frames()).find((f) => f.type === "event" && f.text === "the build finished"),
    );
    // the worker prompts it when the line is quiet
    const { id } = await worker<{ id: string }>("/test/say", { text: "the build finished", kind: "event" });
    await until(async () => (await frames()).find((f) => f.type === "done" && f.id === id));
    const ms = await messages(agent);
    expect(ms.at(-2)).toMatchObject({
      kind: "text",
      text: "the build finished",
      data: { source: "event", fromAgentId: agent.id },
    });
    expect(prompted).toEqual([ms.at(-2)!.turnId!]);
    expect(ms.at(-1)).toMatchObject({ kind: "voice_transcript", role: "agent" });
  });

  test("state and latency from the worker update the call", async () => {
    await worker("/test/state", { state: "speaking" });
    await worker("/test/latency", {});
    const c = await until(async () => {
      const [c] = await api<Call[]>("/api/voice/calls");
      return c?.state === "speaking" && c.lastTurn && c;
    });
    expect(c.lastTurn?.ms.first_audio_out).toBe(1234);
    expect((await api<AgentView>(`/api/agents/${agent.id}`)).presenceDetail).toBe("speaking");
  });

  test("a spoken request stuck behind a turn waiting for approval: the worker hears why at once", async () => {
    // a text turn in the DM asks for a permission nobody has answered yet
    const typed = app.services.chat.prompt(agent.id, { text: "permission please", source: "user" });
    const perm = await until(async () =>
      (await messages(agent)).find((m) => m.kind === "permission" && m.status === "pending"),
    );
    const t0 = Date.now();
    const { id } = await worker<{ id: string }>("/test/say", { text: "are you there" });
    const waiting = await until(async () =>
      (await frames()).find((f) => f.type === "waiting" && f.id === id),
    );
    expect(Date.now() - t0).toBeLessThan(1500); // not after the worker's 45 s prompt timeout
    expect(waiting).toMatchObject({ reason: "permission", title: "Run rm -rf build" });
    const c = await until(async () => (await callNow())?.waiting && (await callNow()));
    expect(c?.waiting).toEqual({ reason: "permission", detail: "Run rm -rf build" });
    // approving in the chat lets the spoken request through
    await api(`/api/messages/${perm.id}/permission`, { method: "POST", json: { optionId: "allow" } });
    expect((await typed.done).status).toBe("complete");
    const done = await until(async () => (await frames()).find((f) => f.type === "done" && f.id === id));
    expect(done.status).toBe("complete");
    await until(async () => (await callNow())?.waiting === null);
  });

  test("hang up ends the call, tells the worker and clears presence", async () => {
    const ev = events();
    await ev.opened;
    await api(`/api/voice/calls/${call.id}`, { method: "DELETE" });
    await ev.find((e) => e.type === "call.upsert" && e.call.state === "ended");
    expect(await api<Call[]>("/api/voice/calls")).toEqual([]);
    expect((await api<AgentView>(`/api/agents/${agent.id}`)).presence).toBe("idle");
    expect((await frames()).some((f) => f.type === "end")).toBe(true);
    ev.ws.close();
  });

  test("a worker that refuses the offer fails the call cleanly", async () => {
    const res = await raw("/api/voice/calls", {
      method: "POST",
      json: { agentId: agent.id, sdp: "v=0 refuse", type: "offer" },
    });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { hint?: string }).hint).toBe("settings:voice");
    expect(await api<Call[]>("/api/voice/calls")).toEqual([]);
    expect((await api<AgentView>(`/api/agents/${agent.id}`)).presence).toBe("idle");
  });

  test("deleting an agent in a call hangs up, stops its harness, and nothing brings it back", async () => {
    const doomed = await api<AgentView>("/api/agents", {
      method: "POST",
      json: {
        name: "Doomed",
        avatar: { emoji: "🪦", color: "#555555" },
        harnessId: agent.harnessId,
        cwd: dataDir,
      },
    });
    const ev = events();
    await ev.opened;
    const { call: c } = await api<StartCallResponse>("/api/voice/calls", {
      method: "POST",
      json: { agentId: doomed.id, sdp: "v=0 offer", type: "offer" },
    });
    const pid = await until(async () => app.services.chat.pids()[doomed.id]); // the call warmed it
    // a spoken request is mid-reply when the agent is deleted
    const { id } = await worker<{ id: string }>("/test/say", { text: "tell me something slow" });
    await until(async () => (await frames()).find((f) => f.type === "text" && f.id === id));
    await api(`/api/agents/${doomed.id}`, { method: "DELETE" });
    const ended = await ev.find<Extract<ServerEvent, { type: "call.upsert" }>>(
      (e) => e.type === "call.upsert" && e.call.id === c.id && e.call.state === "ended",
    );
    expect(ended.call.endReason).toBe("the agent was deleted");
    expect(alive(pid)).toBe(false);
    expect(() => app.services.chat.prompt(doomed.id, { text: "hi", source: "voice" })).toThrow(/not found/);
    await Bun.sleep(300);
    expect(app.services.chat.pids()[doomed.id]).toBeUndefined();
    ev.ws.close();
  });

  test("a remote worker that isn't set up: calls are refused with a hint", async () => {
    await api("/api/voice/settings", { method: "PATCH", json: { workerMode: "remote" } });
    const s = await status();
    expect(s.worker).toMatchObject({ mode: "remote", state: "off", pid: null });
    const res = await raw("/api/voice/calls", {
      method: "POST",
      json: { agentId: agent.id, sdp: "v=0 offer", type: "offer" },
    });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { hint?: string }).hint).toBe("settings:voice");
  });
});

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type Call,
  type CallState,
  type GpuSpeechAction,
  type IceBody,
  type RecordingsResponse,
  type ServiceHealth,
  type StartCallBody,
  type StartCallResponse,
  type SttModel,
  type SttModelAction,
  type SttModelsResponse,
  type TurnRecording,
  type VoiceSettings,
  type VoiceSettingsPatchBody,
  type VoiceStatus,
  type VoicesResponse,
  voicePaths,
} from "@vibe-center/shared";
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import { dataPaths } from "../config.ts";
import type { Repos } from "../db/repos/index.ts";
import type { ChatService } from "../domain/chat.ts";
import { HttpError } from "../domain/errors.ts";
import type { PresenceStore } from "../domain/presence.ts";
import type { EventBus } from "../events/bus.ts";
import { type ProcessTracker, stopGroup } from "../procs.ts";
import { type BridgeSocketData, CallBridge, type SpokenEvent } from "./bridge.ts";
import { publicSettings, type StoredVoiceSettings, VoiceSettingsStore } from "./settings.ts";
import { listSttModels, sttModelAction } from "./stt-models.ts";
import { ManagedWorker, WorkerClient, WorkerError, type WorkerHealth } from "./worker.ts";

const REPO = join(import.meta.dir, "../../../..");
export const DEFAULT_WORKER_COMMAND = [join(REPO, "services/voice/run.sh")];
export const GPU_SPEECH_SCRIPT = join(REPO, "services/speech-gpu/speech.sh");

export interface VoiceOptions {
  /** Start the managed worker with the app (the CLI does; tests opt in). Default false. */
  autostart?: boolean;
  /** Managed worker command line (tests: the fake worker). Default services/voice/run.sh. */
  workerCommand?: string[];
  /** Health check period. Default 5 s. */
  healthIntervalMs?: number;
  /** First restart delay after a crash. Default 1 s. */
  restartDelayMs?: number;
  /** `speech.sh` for the km-pc GPU servers; null hides "Start GPU speech". */
  gpuSpeechScript?: string | null;
  /** A call whose media never connects is ended after this long. Default 30 s. */
  connectTimeoutMs?: number;
}

interface LiveCall {
  call: Call;
  tokenHash: string;
  bridge: CallBridge;
  connectTimer: ReturnType<typeof setTimeout>;
}

const SERVICE_OFF = (message: string): ServiceHealth => ({ state: "off", message, checkedAt: Date.now() });

/**
 * Voice calls (phase 2b). Owns the worker (managed child process or remote URL) and its health,
 * the calls and their bridges, and the voice settings. Signalling from the browser comes in
 * through the authenticated API and is proxied to the worker; the worker's LLM step comes back
 * through the bridge into `ChatService.prompt`.
 *
 * Hook for other phases: `speakEvent(agentId, text)` delivers a proactive event (e.g. another
 * agent's reply) into a running call with that agent, spoken when the line is quiet. It returns
 * false when there is no call, so the caller prompts the agent as usual.
 */
export class VoiceService {
  private readonly store: VoiceSettingsStore;
  private managed: ManagedWorker | null = null;
  private calls = new Map<string, LiveCall>();
  private appPort = 0;
  private publicUrl: string | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private checking: Promise<void> | null = null;
  private lastPublished = "";
  private gpuJob: { action: GpuSpeechAction; pid: number | null; done: Promise<void> } | null = null;
  private stopped = false;
  private starting: Promise<void> = Promise.resolve();
  private state: VoiceStatus;

  constructor(
    private readonly deps: {
      repos: Repos;
      bus: EventBus;
      chat: ChatService;
      presence: PresenceStore;
      dataDir: string;
      tracker?: ProcessTracker;
    },
    private readonly opts: VoiceOptions = {},
  ) {
    this.store = new VoiceSettingsStore(deps.repos.db);
    const s = this.store.get();
    const unchecked: ServiceHealth = { state: "starting", message: null, checkedAt: null };
    this.state = {
      worker: {
        ...unchecked,
        mode: s.workerMode,
        url: null,
        pid: null,
        restarts: 0,
        version: null,
        logTail: [],
      },
      stt: { ...unchecked, url: s.sttUrl },
      tts: { ...unchecked, url: s.ttsUrl },
      gpuSpeech: {
        available: this.gpuScript() !== null,
        running: null,
        lastAction: null,
        lastExitCode: null,
        lastOutput: "",
      },
    };
  }

  // ---- lifecycle ------------------------------------------------------------------------------

  /** Called once the HTTP server listens (the managed worker's bridge URL needs the port). */
  start(appPort: number): Promise<void> {
    this.appPort = appPort;
    this.starting = (async () => {
      const s = this.store.get();
      if (s.workerMode === "managed" && this.opts.autostart) await this.ensureManaged();
      if (this.stopped) return;
      this.healthTimer = setInterval(() => void this.checkHealth(), this.opts.healthIntervalMs ?? 5000);
      void this.checkHealth();
    })().catch((e) => console.error("voice: could not start the worker", e));
    return this.starting;
  }

  /** The tailnet URL (from `tailscale serve`), used as the bridge URL for a remote worker. */
  setPublicUrl(url: string | null): void {
    this.publicUrl = url;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.starting;
    if (this.healthTimer) clearInterval(this.healthTimer);
    for (const id of [...this.calls.keys()]) await this.hangUp(id, "server stopping");
    await this.managed?.stop();
    this.managed = null;
    // a `speech.sh up` can poll km-pc for minutes; it doesn't outlive the app
    const job = this.gpuJob;
    if (job?.pid) {
      await stopGroup(job.pid, 2000);
      await job.done;
    }
  }

  // ---- settings and status --------------------------------------------------------------------

  settings(): VoiceSettings {
    return publicSettings(this.store.get());
  }

  async updateSettings(patch: VoiceSettingsPatchBody): Promise<VoiceSettings> {
    const before = this.store.get();
    const after = this.store.update(patch);
    if (after.workerMode !== before.workerMode) {
      for (const id of [...this.calls.keys()]) await this.hangUp(id, "voice worker changed");
      if (after.workerMode === "managed") await this.ensureManaged();
      else {
        await this.managed?.stop();
        this.managed = null;
      }
    }
    await this.checkHealth();
    return publicSettings(after);
  }

  status(): VoiceStatus {
    return { ...this.state, worker: { ...this.state.worker, logTail: [...(this.managed?.tail ?? [])] } };
  }

  async restartWorker(): Promise<VoiceStatus> {
    const s = this.store.get();
    if (s.workerMode !== "managed") throw new HttpError(400, "the worker is remote; restart it there");
    for (const id of [...this.calls.keys()]) await this.hangUp(id, "voice worker restarted");
    if (this.managed) await this.managed.restart();
    else await this.ensureManaged();
    await this.checkHealth();
    return this.status();
  }

  /** Check the worker, STT and TTS; publishes `voice.status` when something changed. */
  checkHealth(): Promise<void> {
    this.checking ??= this.runHealthCheck().finally(() => {
      this.checking = null;
    });
    return this.checking;
  }

  private async runHealthCheck(): Promise<void> {
    const s = this.store.get();
    const [worker, stt, tts] = await Promise.all([
      this.workerHealth(s),
      speechHealth(s.sttUrl, "STT"),
      speechHealth(s.ttsUrl, "TTS"),
    ]);
    if (this.stopped) return;
    this.state = { ...this.state, worker, stt: { ...stt, url: s.sttUrl }, tts: { ...tts, url: s.ttsUrl } };
    this.publishStatus();
  }

  private async workerHealth(s: StoredVoiceSettings): Promise<VoiceStatus["worker"]> {
    const base = { mode: s.workerMode, pid: null, restarts: 0, version: null, logTail: [] };
    const now = Date.now();
    if (s.workerMode === "managed") {
      const m = this.managed;
      const info = { ...base, url: m?.url ?? null, pid: m?.pid ?? null, restarts: m?.restarts ?? 0 };
      if (!m) return { ...info, state: "off", message: "Not started.", checkedAt: now };
      if (!m.running) {
        const message = m.restartPending
          ? `Crashed (${m.lastExit}); restarting.`
          : `Stopped${m.lastExit ? ` (${m.lastExit})` : ""}.`;
        return { ...info, state: "error", message, checkedAt: now };
      }
    } else if (!s.workerUrl) {
      return { ...base, url: null, state: "off", message: "Set the remote worker's URL.", checkedAt: now };
    }
    const client = this.client(s);
    const info = {
      ...base,
      url: client?.url ?? null,
      pid: this.managed?.pid ?? null,
      restarts: this.managed?.restarts ?? 0,
    };
    try {
      const h = await client!.json<WorkerHealth>("/health", { timeoutMs: 2000 });
      const state = h.status === "ok" ? "ok" : h.status === "loading" ? "starting" : "error";
      const message = h.status === "loading" ? "Loading speech models…" : h.error;
      return { ...info, version: h.version, state, message, checkedAt: now };
    } catch (e) {
      const auth = e instanceof WorkerError && e.status === 401;
      const message = auth
        ? "The worker refused the token."
        : s.workerMode === "managed"
          ? "Starting…"
          : `Unreachable: ${(e as Error).message}`;
      return {
        ...info,
        state: auth ? "error" : s.workerMode === "managed" ? "starting" : "down",
        message,
        checkedAt: now,
      };
    }
  }

  private publishStatus(): void {
    const { worker, stt, tts, gpuSpeech } = this.state;
    const strip = ({ checkedAt: _, ...h }: ServiceHealth & object) => h;
    const key = JSON.stringify([strip(worker), strip(stt), strip(tts), gpuSpeech]);
    if (key === this.lastPublished) return;
    this.lastPublished = key;
    this.deps.bus.publish({ type: "voice.status", status: this.status() });
  }

  private async ensureManaged(): Promise<void> {
    if (this.stopped) return;
    this.managed ??= new ManagedWorker({
      command: this.opts.workerCommand ?? DEFAULT_WORKER_COMMAND,
      dataDir: join(this.deps.dataDir, "voice"),
      logFile: join(dataPaths(this.deps.dataDir).logs, "voice-worker.log"),
      restartDelayMs: this.opts.restartDelayMs,
      tracker: this.deps.tracker,
      onChange: () => void this.checkHealth(),
    });
    await this.managed.start();
  }

  private client(s = this.store.get()): WorkerClient | null {
    if (s.workerMode === "managed") return this.managed?.running ? this.managed.client() : null;
    return s.workerUrl ? new WorkerClient(s.workerUrl, s.workerToken) : null;
  }

  private requireWorker(): WorkerClient {
    const client = this.client();
    if (!client || this.state.worker.state !== "ok") {
      const why = this.state.worker.message ? ` (${this.state.worker.message})` : "";
      throw new HttpError(503, `The voice worker isn't ready${why}.`, "settings:voice");
    }
    return client;
  }

  // ---- voices ---------------------------------------------------------------------------------

  async voices(): Promise<VoicesResponse> {
    const tts = this.store.get().ttsUrl;
    return this.requireWorker().json<VoicesResponse>(`/voices?tts_url=${encodeURIComponent(tts)}`, {
      timeoutMs: 5000,
    });
  }

  /** A short sample of a voice as WAV, through the worker (GPU TTS if up, else CPU). */
  async preview(voice: string | null, text?: string): Promise<Response> {
    const res = await this.requireWorker().request("/tts", {
      method: "POST",
      json: { text: text ?? "Hi, this is how I sound on a call.", voice, tts_url: this.store.get().ttsUrl },
      timeoutMs: 20_000,
    });
    if (!res.ok) throw new HttpError(502, `voice preview failed: ${await res.text()}`);
    return new Response(res.body, { headers: { "content-type": "audio/wav", "cache-control": "no-store" } });
  }

  // ---- speech-to-text models and debug recordings ---------------------------------------------

  /** The STT server's catalog with each model's status (never throws: offline is a state). */
  sttModels(): Promise<SttModelsResponse> {
    return listSttModels(this.store.get().sttUrl);
  }

  async sttModelAction(id: string, action: SttModelAction | "cancel" | "delete"): Promise<SttModel> {
    const model = await sttModelAction(this.store.get().sttUrl, id, action);
    if (action === "activate") void this.checkHealth();
    return model;
  }

  /** What the worker kept of recent turns (Settings → Voice → debug recordings). */
  async recordings(): Promise<RecordingsResponse> {
    const res = await this.requireWorker().json<{ recordings: RawRecording[] }>("/recordings", {
      timeoutMs: 5000,
    });
    return {
      recordings: res.recordings.map(
        (r): TurnRecording => ({
          id: r.id,
          callId: r.call_id,
          turn: r.turn,
          text: r.text,
          stt: r.stt,
          duration: r.duration,
          at: r.at,
        }),
      ),
    };
  }

  async recordingAudio(id: string): Promise<Response> {
    const res = await this.requireWorker().request(`/recordings/${encodeURIComponent(id)}.wav`, {
      timeoutMs: 10_000,
    });
    if (res.status === 404) throw new HttpError(404, "no such recording");
    if (!res.ok) throw new HttpError(502, `the worker answered ${res.status}`);
    return new Response(res.body, { headers: { "content-type": "audio/wav", "cache-control": "no-store" } });
  }

  async clearRecordings(): Promise<number> {
    const res = await this.requireWorker().json<{ deleted: number }>("/recordings", {
      method: "DELETE",
      timeoutMs: 5000,
    });
    return res.deleted;
  }

  /** The settings' vocabulary plus every agent's name, without duplicates. */
  private vocabulary(s: StoredVoiceSettings): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const term of [...s.sttVocabulary, ...this.deps.repos.agents.list().map((a) => a.name)]) {
      const key = term.trim().toLowerCase();
      if (key && !seen.has(key)) {
        seen.add(key);
        out.push(term.trim());
      }
    }
    return out;
  }

  // ---- calls ----------------------------------------------------------------------------------

  listCalls(): Call[] {
    return [...this.calls.values()].map((c) => c.call);
  }

  async startCall(deviceId: string, body: StartCallBody): Promise<StartCallResponse> {
    const agent = this.deps.chat.requireAgent(body.agentId); // 404 also while it's being deleted
    const conversation = this.deps.repos.conversations.dmFor(agent.id);
    if (!conversation) throw new HttpError(404, "the agent has no DM");
    const client = this.requireWorker();
    // One call at a time (one worker pipeline, one mic): a new call replaces the old one.
    for (const id of [...this.calls.keys()]) await this.hangUp(id, "replaced by a new call");

    const s = this.store.get();
    const id = crypto.randomUUID();
    const token = randomToken();
    const call: Call = {
      id,
      agentId: agent.id,
      conversationId: conversation.id,
      deviceId,
      state: "connecting",
      startedAt: Date.now(),
      endedAt: null,
      endReason: null,
      speech: null,
      lastTurn: null,
      waiting: null,
      muted: false,
    };
    const bridge = new CallBridge(id, agent.id, agent.name, this.deps.chat, this.deps.bus, {
      onState: (state) => this.setState(id, state),
      onLatency: (turn) => this.update(id, (c) => ({ ...c, lastTurn: turn })),
      onWaiting: (waiting) => this.update(id, (c) => ({ ...c, waiting })),
      onClose: (reason) => this.endCall(id, reason),
    });
    const connectTimer = setTimeout(() => {
      if (this.calls.get(id)?.call.state === "connecting") void this.hangUp(id, "the call never connected");
    }, this.opts.connectTimeoutMs ?? 30_000);
    this.calls.set(id, { call, tokenHash: hashToken(token), bridge, connectTimer });
    this.deps.presence.setOverride(agent.id, { presence: "in_call", detail: "connecting" });
    this.publishCall(call);
    // spawn the harness and open its session while the media connects, not on the first words
    void this.deps.chat.warm(agent.id).catch(() => {});

    try {
      // The worker dials the bridge during this request, before it answers.
      const res = await client.json<{ sdp: string; type: string; pc_id: string; speech: Call["speech"] }>(
        "/calls",
        {
          method: "POST",
          timeoutMs: 20_000,
          json: {
            call_id: id,
            bridge_url: this.bridgeUrl(s),
            bridge_token: token,
            agent_name: agent.name,
            voice: agent.voice,
            stt_url: s.sttUrl,
            tts_url: s.ttsUrl,
            filler: s.filler,
            vocabulary: this.vocabulary(s),
            stt_language: s.sttLanguage,
            record_turns: s.recordTurns,
            sdp: body.sdp,
            type: body.type,
          },
        },
      );
      // a call started from another device meanwhile replaced this one: don't hand out its answer
      if (!this.calls.has(id)) throw new HttpError(409, "the call was replaced by another one");
      const updated = this.update(id, (c) => ({ ...c, speech: res.speech }));
      return { call: updated ?? call, answer: { sdp: res.sdp, type: "answer", pcId: res.pc_id } };
    } catch (e) {
      if (e instanceof HttpError) throw e;
      this.endCall(id, "the voice worker could not start the call");
      const msg = e instanceof WorkerError ? e.message : (e as Error).message;
      throw new HttpError(502, `The voice worker could not start the call: ${msg}`, "settings:voice");
    }
  }

  async ice(callId: string, body: IceBody): Promise<void> {
    if (!this.calls.has(callId)) throw new HttpError(404, "no such call");
    const res = await this.requireWorker().request(`/calls/${callId}/ice`, {
      method: "PATCH",
      json: {
        pc_id: body.pcId,
        candidates: body.candidates.map((c) => ({
          candidate: c.candidate,
          sdp_mid: c.sdpMid ?? null,
          sdp_mline_index: c.sdpMLineIndex ?? null,
        })),
      },
    });
    if (!res.ok) throw new HttpError(502, `ICE candidates refused: ${await res.text()}`);
  }

  /** Mute from any tab or device: the worker silences the mic, the media's tab follows suit. */
  setMuted(callId: string, muted: boolean): Call {
    const live = this.calls.get(callId);
    if (!live) throw new HttpError(404, "no such call");
    live.bridge.mute(muted);
    return this.update(callId, (c) => ({ ...c, muted })) ?? live.call;
  }

  async hangUp(callId: string, reason = "hung up"): Promise<void> {
    const live = this.calls.get(callId);
    if (!live) return;
    live.bridge.end(reason); // ends the call through onClose
    this.endCall(callId, reason);
    // in case the bridge never connected: tell the worker directly too
    await this.client()
      ?.request(`/calls/${callId}`, { method: "DELETE", timeoutMs: 2000 })
      .catch(() => {});
  }

  /** End every call with this agent (it is being deleted). */
  async hangUpAgent(agentId: string, reason: string): Promise<void> {
    for (const live of [...this.calls.values()]) {
      if (live.call.agentId === agentId) await this.hangUp(live.call.id, reason);
    }
  }

  /** Debug/testing: speak an event in a given call. */
  injectEvent(callId: string, text: string): void {
    const live = this.calls.get(callId);
    if (!live) throw new HttpError(404, "no such call");
    if (!live.bridge.sendEvent(text)) throw new HttpError(409, "the call is not connected yet");
  }

  /**
   * The hook for proactive events: if the user is in a call with this agent, the worker speaks
   * `text` (as an `event` turn in the agent's session) once nobody is talking and the agent is
   * idle. Returns false when there's no connected call; then prompt the agent as usual. `opts`:
   * a hidden note for the agent, the sending agent, and a callback with the turn once prompted.
   */
  speakEvent(agentId: string, text: string, opts: SpokenEvent = {}): boolean {
    for (const live of this.calls.values()) {
      if (live.call.agentId === agentId && live.bridge.sendEvent(text, opts)) return true;
    }
    return false;
  }

  /** The agent's active call, if any. */
  callFor(agentId: string): Call | null {
    for (const live of this.calls.values()) if (live.call.agentId === agentId) return live.call;
    return null;
  }

  private setState(id: string, state: CallState): void {
    const call = this.update(id, (c) => ({ ...c, state }));
    if (call) this.deps.presence.setOverride(call.agentId, { presence: "in_call", detail: state });
  }

  private update(id: string, fn: (c: Call) => Call): Call | null {
    const live = this.calls.get(id);
    if (!live) return null;
    const next = fn(live.call);
    if (JSON.stringify(next) === JSON.stringify(live.call)) return next;
    live.call = next;
    this.publishCall(next);
    return next;
  }

  private endCall(id: string, reason: string): void {
    const live = this.calls.get(id);
    if (!live) return;
    this.calls.delete(id);
    clearTimeout(live.connectTimer);
    live.bridge.close(reason);
    const call: Call = { ...live.call, state: "ended", endedAt: Date.now(), endReason: reason };
    this.deps.presence.setOverride(call.agentId, null);
    this.publishCall(call);
  }

  private publishCall(call: Call): void {
    this.deps.bus.publish({ type: "call.upsert", call });
  }

  private bridgeUrl(s: StoredVoiceSettings): string {
    const local = `http://127.0.0.1:${this.appPort}`;
    const base = s.workerMode === "managed" ? local : s.appUrl || this.publicUrl || local;
    return `${base.replace(/\/$/, "").replace(/^http/, "ws")}${voicePaths.bridge}`;
  }

  // ---- bridge sockets -------------------------------------------------------------------------

  /** Upgrade the worker's bridge connection, authenticated by its per-call Bearer token. */
  upgrade(req: Request, server: Server<BridgeSocketData>): Response | undefined {
    const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const hash = token ? hashToken(token) : "";
    const live = [...this.calls.values()].find((c) => timingSafeEqual(c.tokenHash, hash));
    if (!live || live.bridge.connected)
      return new Response("unknown or used call credential", { status: 401 });
    if (server.upgrade(req, { data: { bridgeCallId: live.call.id } })) return undefined;
    return new Response("expected a websocket upgrade", { status: 400 });
  }

  readonly socketHandler: WebSocketHandler<BridgeSocketData> = {
    data: {} as BridgeSocketData,
    open: (ws: ServerWebSocket<BridgeSocketData>) => {
      const live = this.calls.get(ws.data.bridgeCallId);
      if (!live) ws.close(1008, "call ended");
      else live.bridge.attach(ws);
    },
    message: (ws, raw) => {
      this.calls.get(ws.data.bridgeCallId)?.bridge.handle(raw);
    },
    close: (ws) => {
      this.calls.get(ws.data.bridgeCallId)?.bridge.close("the voice worker disconnected");
    },
  };

  // ---- GPU speech (km-pc) ---------------------------------------------------------------------

  private gpuScript(): string | null {
    const script = this.opts.gpuSpeechScript === undefined ? GPU_SPEECH_SCRIPT : this.opts.gpuSpeechScript;
    if (!script || !existsSync(script)) return null;
    // speech.sh drives km-pc through the `gpu` helper; only offer it where that exists
    return this.opts.gpuSpeechScript !== undefined || Bun.which("gpu") ? script : null;
  }

  /** Run `speech.sh up|down|status` in the background; progress arrives as `voice.status`. */
  gpuSpeech(action: GpuSpeechAction): VoiceStatus {
    const script = this.gpuScript();
    if (!script) throw new HttpError(404, "GPU speech control isn't available on this machine");
    if (this.stopped) throw new HttpError(503, "the server is stopping");
    if (this.gpuJob) throw new HttpError(409, `speech.sh ${this.gpuJob.action} is still running`);
    this.state = { ...this.state, gpuSpeech: { ...this.state.gpuSpeech, running: action, lastOutput: "" } };
    this.publishStatus();
    // own process group, so stop() also reaches the `gpu ssh` it runs
    const child = spawn("bash", [script, action], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: { ...process.env, ...this.deps.tracker?.env },
    });
    const untrack = child.pid ? (this.deps.tracker?.track(child.pid, `speech.sh ${action}`) ?? null) : null;
    let finished!: () => void;
    this.gpuJob = { action, pid: child.pid ?? null, done: new Promise((r) => (finished = r)) };
    let output = "";
    const add = (d: Buffer) => {
      output = (output + d.toString()).slice(-20_000);
    };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    child.once("error", (e) => add(Buffer.from(`could not run speech.sh: ${e.message}\n`)));
    child.once("close", (code) => {
      untrack?.();
      finished();
      this.gpuJob = null;
      this.state = {
        ...this.state,
        gpuSpeech: {
          ...this.state.gpuSpeech,
          running: null,
          lastAction: action,
          lastExitCode: code,
          lastOutput: output,
        },
      };
      this.publishStatus();
      void this.checkHealth();
    });
    return this.status();
  }
}

interface RawRecording {
  id: string;
  call_id: string;
  turn: number;
  text: string;
  stt: string;
  duration: number;
  at: number;
}

async function speechHealth(url: string, what: string): Promise<ServiceHealth> {
  const cpu = what === "STT" ? "Whisper" : "Kokoro";
  if (!url) return SERVICE_OFF(`Not set: calls use the worker's CPU ${cpu}.`);
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(1500) });
    if (res.ok) return { state: "ok", message: null, checkedAt: Date.now() };
    return { state: "starting", message: `Answers ${res.status}: still loading?`, checkedAt: Date.now() };
  } catch {
    return {
      state: "down",
      message: `Unreachable: calls use the worker's CPU ${cpu}.`,
      checkedAt: Date.now(),
    };
  }
}

function randomToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

function hashToken(token: string): string {
  return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length || !a) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

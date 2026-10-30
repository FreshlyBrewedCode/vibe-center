// Phase 2b (voice calls): HTTP contract under /api/voice and the call/status types.
// The browser only ever talks to the app: signalling for WebRTC is proxied to the voice worker,
// and only the media flows directly between the browser and the worker's host.
import { z } from "zod";
import type { Id, Timestamp } from "./domain.ts";

export const voicePaths = {
  settings: "/api/voice/settings",
  status: "/api/voice/status",
  workerRestart: "/api/voice/worker/restart",
  gpuSpeech: (action: GpuSpeechAction) => `/api/voice/gpu-speech/${action}`,
  voices: "/api/voice/voices",
  preview: "/api/voice/preview",
  calls: "/api/voice/calls",
  call: (id: string) => `/api/voice/calls/${id}`,
  callIce: (id: string) => `/api/voice/calls/${id}/ice`,
  callEvent: (id: string) => `/api/voice/calls/${id}/event`,
  /** The STT server's model catalog, proxied (it may run on another machine). */
  sttModels: "/api/voice/stt/models",
  sttModel: (id: string) => `/api/voice/stt/models/${encodeURIComponent(id)}`,
  sttModelAction: (id: string, action: SttModelAction) =>
    `/api/voice/stt/models/${encodeURIComponent(id)}/${action}`,
  /** Debug turn recordings kept by the worker (Settings → Voice). */
  recordings: "/api/voice/recordings",
  recording: (id: string) => `/api/voice/recordings/${encodeURIComponent(id)}.wav`,
  /** The worker's WebSocket back into the app (per-call Bearer credential, not the cookie). */
  bridge: "/voice/bridge",
} as const;

// ---- settings ---------------------------------------------------------------------------------

export const WORKER_MODES = ["managed", "remote"] as const;
export type WorkerMode = (typeof WORKER_MODES)[number];

/** Voice settings as stored (`settings` row "voice") and returned, minus the remote token. */
export interface VoiceSettings {
  /** `managed`: the app runs services/voice as a child process. `remote`: a worker at `workerUrl`. */
  workerMode: WorkerMode;
  workerUrl: string;
  /** True when a token for the remote worker is stored (the token itself is never returned). */
  workerTokenSet: boolean;
  /** How a remote worker reaches this app's bridge; empty = the tailnet URL (or loopback). */
  appUrl: string;
  /** OpenAI-compatible STT server; empty = always the worker's CPU Whisper. */
  sttUrl: string;
  /** OpenAI-compatible TTS server; empty = always the worker's CPU Kokoro. */
  ttsUrl: string;
  /** Spoken filler ("One sec.") when a tool call starts before the agent said anything. */
  filler: boolean;
  /**
   * Terms the STT should recognise (project names, jargon). Every agent's name is added per call.
   * Used where the active model supports it (Whisper: hotwords); see `SttModel.supportsVocabulary`.
   */
  sttVocabulary: string[];
  /**
   * What the user speaks, as an ISO 639-1 code ("en", "de", …), or "" to let a multilingual model
   * detect it per utterance. English-only models ignore it.
   */
  sttLanguage: string;
  /** Debug: keep the last N user turns of calls as audio + transcript on the worker. 0 = off. */
  recordTurns: number;
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  workerMode: "managed",
  workerUrl: "",
  workerTokenSet: false,
  appUrl: "",
  // the km-pc GPU servers through `speech.sh up`'s tunnels; CPU fallback when they're down
  sttUrl: "http://127.0.0.1:8401",
  ttsUrl: "http://127.0.0.1:8402",
  filler: true,
  sttVocabulary: [],
  sttLanguage: "en",
  recordTurns: 0,
};

export const MAX_RECORD_TURNS = 200;

const url = z.union([z.literal(""), z.url({ protocol: /^https?$/ })]);
// Default-free field set: PATCH must never fill in defaults over stored values.
export const VoiceSettingsPatchBody = z
  .object({
    workerMode: z.enum(WORKER_MODES),
    workerUrl: url,
    /** Write-only. Empty string clears it. */
    workerToken: z.string().max(500),
    appUrl: url,
    sttUrl: url,
    ttsUrl: url,
    filler: z.boolean(),
    sttVocabulary: z.array(z.string().trim().min(1).max(100)).max(200),
    sttLanguage: z.string().regex(/^([a-z]{2})?$/, "an ISO 639-1 code like en, or empty to detect"),
    recordTurns: z.number().int().min(0).max(MAX_RECORD_TURNS),
  })
  .partial();
export type VoiceSettingsPatchBody = z.input<typeof VoiceSettingsPatchBody>;

// ---- status -----------------------------------------------------------------------------------

export type ServiceState = "ok" | "starting" | "down" | "error" | "off";

export interface ServiceHealth {
  state: ServiceState;
  /** What's wrong or what happens instead (e.g. "unreachable: calls use the CPU fallback"). */
  message: string | null;
  checkedAt: Timestamp | null;
}

export interface VoiceStatus {
  worker: ServiceHealth & {
    mode: WorkerMode;
    url: string | null;
    pid: number | null;
    restarts: number;
    version: string | null;
    /** Last lines of the managed worker's output. */
    logTail: string[];
  };
  stt: ServiceHealth & { url: string };
  tts: ServiceHealth & { url: string };
  /** `services/speech-gpu/speech.sh` on this machine (km-pc GPU servers), if it can run here. */
  gpuSpeech: {
    available: boolean;
    running: GpuSpeechAction | null;
    lastAction: GpuSpeechAction | null;
    lastExitCode: number | null;
    lastOutput: string;
  };
}

export const GPU_SPEECH_ACTIONS = ["up", "down", "status"] as const;
export type GpuSpeechAction = (typeof GPU_SPEECH_ACTIONS)[number];

// ---- speech-to-text models (the STT server's catalog) -----------------------------------------

export const STT_MODEL_ACTIONS = ["download", "activate"] as const;
export type SttModelAction = (typeof STT_MODEL_ACTIONS)[number];

/** `absent`: not on disk. `ready`: downloaded. `loading`: being activated. `active`: serving. */
export type SttModelStatus = "absent" | "downloading" | "ready" | "loading" | "active";

export interface SttModel {
  id: string;
  name: string;
  /** "onnx-asr" | "faster-whisper" */
  backend: string;
  downloadMb: number;
  /** What the model's files take on the server now (0 when absent). */
  diskMb: number;
  vramMb: number;
  /** Median server time per utterance, measured on the GPU box. */
  latencyMs: number;
  /** Word error rate (%) on the project's evaluation set, if measured. */
  wer: number | null;
  languages: string[];
  accuracy: string;
  supportsVocabulary: boolean;
  recommended: boolean;
  status: SttModelStatus;
  progress: {
    phase: "starting" | "runtime" | "download" | "convert";
    doneBytes: number;
    totalBytes: number;
    /** 0–1 while bytes are counted; null in phases without a size. */
    fraction: number | null;
  } | null;
  /** The last download or activation failure, if any. */
  error: string | null;
}

export interface SttModelsResponse {
  /** The STT URL from the settings. */
  url: string;
  /** False when the server can't be reached, or doesn't have a model catalog (an older one). */
  reachable: boolean;
  message: string | null;
  active: string | null;
  loading: string | null;
  default: string | null;
  models: SttModel[];
}

// ---- debug turn recordings --------------------------------------------------------------------

export interface TurnRecording {
  id: string;
  callId: string;
  turn: number;
  /** The transcript the STT returned for this audio. */
  text: string;
  /** Which STT heard it (a server URL, or "cpu …"). */
  stt: string;
  duration: number;
  at: Timestamp;
}

export interface RecordingsResponse {
  recordings: TurnRecording[];
}

// ---- calls ------------------------------------------------------------------------------------

/** `listening` = the line is open for the user; `thinking` = the agent works on a reply. */
export const CALL_STATES = ["connecting", "listening", "thinking", "speaking", "ended"] as const;
export type CallState = (typeof CALL_STATES)[number];

/** Latency of one call turn, ms after the user stopped speaking (from the worker's log). */
export interface CallTurnLatency {
  turn: number;
  kind: string;
  ms: Partial<
    Record<
      "eot_decision" | "stt_result" | "prompt_sent" | "first_chunk" | "filler_out" | "first_audio_out",
      number
    >
  >;
  bargeIn: string | null;
  tools: number;
}

/**
 * Why the call's current request isn't being answered: the agent waits for an approval in the
 * chat (`permission`, its own turn's or the one running ahead of it), or it is still busy with
 * other work queued ahead (`busy`, e.g. a text message's turn).
 */
export interface CallWaiting {
  reason: "permission" | "busy";
  /** The permission request's title, if any. */
  detail: string | null;
}

export interface Call {
  id: Id;
  agentId: Id;
  conversationId: Id;
  /** The device that holds the media; other devices see the call but can only hang up. */
  deviceId: Id;
  state: CallState;
  startedAt: Timestamp;
  endedAt: Timestamp | null;
  endReason: string | null;
  /** What the worker uses for this call: a server URL, or "cpu". */
  speech: { stt: string; tts: string } | null;
  lastTurn: CallTurnLatency | null;
  /** Set while a spoken request waits on something else; null when it runs (or nothing's asked). */
  waiting: CallWaiting | null;
  /** Muted from any tab or device: the worker hears silence, the device with the media mutes its mic. */
  muted: boolean;
}

const sdpType = z.enum(["offer", "answer", "pranswer", "rollback"]);
export const StartCallBody = z.object({
  agentId: z.string().min(1),
  sdp: z.string().min(1).max(100_000),
  type: sdpType,
});
export type StartCallBody = z.input<typeof StartCallBody>;

export interface StartCallResponse {
  call: Call;
  answer: { sdp: string; type: "answer"; pcId: string };
}

/** Call controls from any of the user's tabs or devices (hang-up is `DELETE`). */
export const CallPatchBody = z.object({ muted: z.boolean() });
export type CallPatchBody = z.input<typeof CallPatchBody>;

export const IceBody = z.object({
  pcId: z.string().min(1),
  candidates: z
    .array(
      z.object({
        candidate: z.string(),
        sdpMid: z.string().nullable().optional(),
        sdpMLineIndex: z.number().int().nullable().optional(),
      }),
    )
    .max(100),
});
export type IceBody = z.input<typeof IceBody>;

export const CallEventBody = z.object({ text: z.string().trim().min(1).max(2000) });
export const PreviewBody = z.object({
  voice: z.string().min(1).max(100).nullable(),
  text: z.string().trim().min(1).max(300).optional(),
});
export type PreviewBody = z.input<typeof PreviewBody>;

export type CallsResponse = Call[];
export interface VoicesResponse {
  voices: string[];
  default: string;
  /** Where the list came from: the TTS server, or the worker's CPU Kokoro. */
  source: "server" | "cpu";
}

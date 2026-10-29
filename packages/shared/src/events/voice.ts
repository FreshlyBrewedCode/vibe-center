// Events owned by phase 2b (voice calls).
import type { Call, VoiceStatus } from "../api-voice.ts";

export type VoiceEvent =
  /** A call started, changed state (listening/thinking/speaking), reported a turn, or ended. */
  | { type: "call.upsert"; call: Call }
  /** Health of the voice worker, STT and TTS, or the GPU speech job, changed. */
  | { type: "voice.status"; status: VoiceStatus };

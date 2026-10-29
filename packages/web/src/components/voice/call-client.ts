// The browser end of a call: microphone, one RTCPeerConnection to the voice worker, playback.
// Signalling goes through the app (`/api/voice/calls`, cookie-authenticated, same origin); only
// the media flows directly to the worker's host. This is client-side media state, so it lives
// in a small module store (useSyncExternalStore), not in TanStack Query. The server's view of
// the call (state, timer start, latency) is `useCalls()`.

import { type Call, type StartCallResponse, voicePaths } from "@vibe-center/shared";
import { useSyncExternalStore } from "react";
import { api } from "@/lib/api";
import { subscribe as subscribeEvents } from "@/lib/events";

export interface LocalCall {
  agentId: string;
  callId: string | null;
  phase: "starting" | "connecting" | "connected" | "ended";
  muted: boolean;
  error: string | null;
}

interface Media {
  pc: RTCPeerConnection;
  mic: MediaStream;
  audio: HTMLAudioElement;
  ping: ReturnType<typeof setInterval> | undefined;
}

let local: LocalCall | null = null;
let media: Media | null = null;
const listeners = new Set<() => void>();

function set(next: LocalCall | null) {
  local = next;
  for (const l of listeners) l();
}

export function useLocalCall(): LocalCall | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => local,
  );
}

// The server ended our call (hung up elsewhere, worker gone, replaced): release the media.
subscribeEvents((e) => {
  if (e.type === "call.upsert" && e.call.state === "ended" && e.call.id === local?.callId) {
    release();
    set({ ...local, phase: "ended", error: endError(e.call) });
  }
});

function endError(call: Call): string | null {
  return call.endReason && call.endReason !== "hung up" ? call.endReason : null;
}

/** Start a call with an agent (ends a call this tab already has). Throws with a readable message. */
export async function startCall(agentId: string): Promise<void> {
  if (local && local.phase !== "ended") await hangUp();
  set({ agentId, callId: null, phase: "starting", muted: false, error: null });
  try {
    const mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    // tailnet: the browser and the worker host reach each other's host candidates directly
    const pc = new RTCPeerConnection({ iceServers: [] });
    const audio = new Audio();
    audio.autoplay = true;
    media = { pc, mic, audio, ping: undefined };
    const track = mic.getAudioTracks()[0];
    if (!track) throw new Error("no microphone track");
    pc.addTransceiver(track, { direction: "sendrecv" });
    // SmallWebRTC expects a data channel; keep it alive like Pipecat's own client does
    const dc = pc.createDataChannel("chat");
    dc.onopen = () => {
      if (media)
        media.ping = setInterval(() => dc.readyState === "open" && dc.send(`ping: ${Date.now()}`), 1000);
    };
    pc.ontrack = (e) => {
      audio.srcObject = e.streams[0] ?? new MediaStream([e.track]);
      void audio.play().catch(() => {});
    };
    pc.onconnectionstatechange = () => {
      if (!local || !media || media.pc !== pc) return;
      if (pc.connectionState === "connected") set({ ...local, phase: "connected" });
      if (pc.connectionState === "failed") void hangUp("The audio connection to the voice worker failed.");
    };
    // candidates found after the (non-trickle) offer went out are sent as ICE patches
    let pcId: string | null = null;
    const late: RTCIceCandidate[] = [];
    let offered = false;
    pc.onicecandidate = (e) => {
      if (!e.candidate || !offered) return;
      if (pcId) void sendCandidates(pcId, [e.candidate]);
      else late.push(e.candidate);
    };

    await pc.setLocalDescription(await pc.createOffer());
    await gathered(pc, 2000);
    offered = true;
    set({ ...local!, phase: "connecting" });
    const res = await api.post<StartCallResponse>(voicePaths.calls, {
      agentId,
      sdp: pc.localDescription!.sdp,
      type: "offer",
    });
    if (!local || media?.pc !== pc) {
      // hung up while the offer was in flight
      await api.delete(voicePaths.call(res.call.id)).catch(() => {});
      return;
    }
    set({ ...local, callId: res.call.id });
    await pc.setRemoteDescription({ type: "answer", sdp: res.answer.sdp });
    pcId = res.answer.pcId;
    if (late.length) void sendCandidates(pcId, late.splice(0));
  } catch (e) {
    release();
    set({ agentId, callId: null, phase: "ended", muted: false, error: (e as Error).message });
    throw e;
  }

  async function sendCandidates(pcId: string, candidates: RTCIceCandidate[]) {
    const callId = local?.callId;
    if (!callId) return;
    await api
      .patch(voicePaths.callIce(callId), {
        pcId,
        candidates: candidates.map((c) => ({
          candidate: c.candidate,
          sdpMid: c.sdpMid,
          sdpMLineIndex: c.sdpMLineIndex,
        })),
      })
      .catch(() => {});
  }
}

/** Hang up this tab's call (and tell the server). */
export async function hangUp(error: string | null = null): Promise<void> {
  const callId = local?.callId ?? null;
  const agentId = local?.agentId;
  release();
  if (agentId) set({ agentId, callId, muted: false, phase: "ended", error });
  if (callId) await api.delete(voicePaths.call(callId)).catch(() => {});
}

/** Hang up a call held by another device (the server ends it there too). */
export async function hangUpRemote(callId: string): Promise<void> {
  await api.delete(voicePaths.call(callId));
}

export function toggleMute(): void {
  if (!local || !media) return;
  const muted = !local.muted;
  for (const t of media.mic.getAudioTracks()) t.enabled = !muted;
  set({ ...local, muted });
}

function release() {
  if (!media) return;
  clearInterval(media.ping);
  media.pc.close();
  for (const t of media.mic.getTracks()) t.stop();
  media.audio.srcObject = null;
  media = null;
}

function gathered(pc: RTCPeerConnection, maxMs: number): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      if (pc.iceGatheringState !== "complete") return;
      pc.removeEventListener("icegatheringstatechange", done);
      resolve();
    };
    pc.addEventListener("icegatheringstatechange", done);
    // host candidates only: gathering is quick; don't hang on a slow interface
    setTimeout(resolve, maxMs);
  });
}

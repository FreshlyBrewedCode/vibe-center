// The browser end of a call: microphone, one RTCPeerConnection to the voice worker, playback.
// Signalling goes through the app (`/api/voice/calls`, cookie-authenticated, same origin); only
// the media flows directly to the worker's host. This is client-side media state, so it lives
// in a small module store (useSyncExternalStore), not in TanStack Query. The server's view of
// the call (state, timer start, latency, muted) is `useCalls()`, and it is the source of truth
// for the controls: hang-up and mute go through the server from any tab or device, and the tab
// holding the media follows the server's call (mutes its mic, releases it when the call ended).

import { hashKey } from "@tanstack/react-query";
import type { Call, CallsResponse, StartCallResponse } from "@vibe-center/shared";
import { voicePaths } from "@vibe-center/shared";
import { useSyncExternalStore } from "react";
import { api } from "@/lib/api";
import { subscribe as subscribeEvents } from "@/lib/events";
import { endCall, keys, queryClient, setCallMuted } from "@/lib/queries";

export interface LocalCall {
  agentId: string;
  callId: string | null;
  phase: "starting" | "connecting" | "connected" | "ended";
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

// Follow the server's call wherever the cache learns about it (events, a resync after the
// channel was down, another tab's or device's mute): mute the mic to match, and let go of the
// media once a call that was up is gone from the server's list.
const callsHash = hashKey(keys.calls);
queryClient.getQueryCache().subscribe((e) => {
  if (e.type !== "updated" || e.query.queryHash !== callsHash || !local?.callId || !media) return;
  const calls = e.query.state.data as CallsResponse | undefined;
  if (!calls) return;
  const call = calls.find((c) => c.id === local?.callId);
  if (call) applyMute(call.muted);
  else if (local.phase === "connected") {
    release();
    set({ ...local, phase: "ended" });
  }
});

function applyMute(muted: boolean) {
  for (const t of media?.mic.getAudioTracks() ?? []) t.enabled = !muted;
}

function endError(call: Call): string | null {
  return call.endReason && call.endReason !== "hung up" ? call.endReason : null;
}

/** Start a call with an agent (ends a call this tab already has). Throws with a readable message. */
export async function startCall(agentId: string): Promise<void> {
  if (local && local.phase !== "ended") await hangUp().catch(() => {});
  set({ agentId, callId: null, phase: "starting", error: null });
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
      if (pc.connectionState === "failed")
        void hangUp(local.callId, "The audio connection to the voice worker failed.").catch(() => {});
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
    set({ agentId, callId: null, phase: "ended", error: (e as Error).message });
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

/**
 * Hang up a call from any tab or device: the server ends it (and the worker, and the media in
 * whichever tab holds it). Without `callId`, this tab's own call, also while it is still being
 * set up. Throws when the server couldn't be reached; this tab's media is released either way.
 */
export async function hangUp(callId: string | null = local?.callId ?? null, error: string | null = null) {
  if (local && (local.callId === callId || callId === null)) {
    release();
    set({ ...local, phase: "ended", error });
  }
  if (callId) await endCall(callId);
}

/** Mute or unmute a call from any tab or device (the worker hears silence while muted). */
export async function setMuted(callId: string, muted: boolean): Promise<void> {
  const holds = local?.callId === callId;
  if (holds) applyMute(muted); // at once here; the server confirms
  try {
    await setCallMuted(callId, muted);
  } catch (e) {
    if (holds) applyMute(!muted);
    throw e;
  }
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

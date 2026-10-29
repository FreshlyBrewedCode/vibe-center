import { useNavigate } from "@tanstack/react-router";
import type { AgentView, Call, CallState, Message } from "@vibe-center/shared";
import { Mic, MicOff, Phone, PhoneOff } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCalls, useMe, useMessages, useVoiceStatus } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { hangUp, hangUpRemote, startCall, toggleMute, useLocalCall } from "./call-client";

/** The active call with this agent, if any (on any device). */
function useAgentCall(agentId: string): Call | null {
  return useCalls().data?.find((c) => c.agentId === agentId) ?? null;
}

/** DM header button: starts a call with the agent. Hidden while a call with it runs. */
export function CallButton({ agent }: { agent: AgentView }) {
  const status = useVoiceStatus();
  const call = useAgentCall(agent.id);
  const local = useLocalCall();
  const navigate = useNavigate();
  const starting =
    local?.agentId === agent.id && (local.phase === "starting" || local.phase === "connecting");
  if (call || starting) return null;
  const worker = status.data?.worker;
  const ready = worker?.state === "ok";
  const button = (
    <Button
      variant="ghost"
      size="sm"
      data-testid="call-button"
      disabled={!ready}
      onClick={() =>
        startCall(agent.id).catch((e: Error) =>
          toast.error(`Call failed: ${e.message}`, {
            action: { label: "Voice settings", onClick: () => navigate({ to: "/settings/voice" }) },
          }),
        )
      }
    >
      <Phone className="size-4" />
      <span className="max-sm:hidden">Call</span>
    </Button>
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>{button}</span>
      </TooltipTrigger>
      <TooltipContent>
        {ready
          ? `Voice call with ${agent.name}`
          : `Voice is offline: ${worker?.message ?? "checking…"} (Settings → Voice)`}
      </TooltipContent>
    </Tooltip>
  );
}

const stateLabel: Record<CallState, string> = {
  connecting: "Connecting…",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
  ended: "Ended",
};

const stateDot: Record<CallState, string> = {
  connecting: "bg-presence-idle animate-pulse",
  listening: "bg-presence-working",
  thinking: "bg-presence-thinking animate-pulse",
  speaking: "bg-presence-in-call animate-pulse",
  ended: "bg-presence-idle",
};

/** Under the DM header while a call with this agent runs: state, timer, mute, hang up, transcript. */
export function CallBar({ agent }: { agent: AgentView }) {
  const call = useAgentCall(agent.id);
  const local = useLocalCall();
  const me = useMe();
  const mine = local?.agentId === agent.id ? local : null;
  const starting = mine && (mine.phase === "starting" || mine.phase === "connecting");

  useEffect(() => {
    if (mine?.phase === "ended" && mine.error) toast.error(`Call ended: ${mine.error}`);
  }, [mine?.phase, mine?.error]);

  if (!call && !starting) return null;
  const here = !call || call.deviceId === me.data?.id;
  const state: CallState = call?.state ?? "connecting";
  return (
    <div data-testid="call-bar" className="shrink-0 border-b bg-muted/40 px-4 py-2">
      <div className="flex items-center gap-3">
        <span className={cn("size-2.5 shrink-0 rounded-full", stateDot[state])} />
        <span data-testid="call-state" className="font-medium text-sm">
          {here ? stateLabel[state] : "In a call on another device"}
        </span>
        {call && <Timer since={call.startedAt} />}
        {call?.lastTurn?.ms.first_audio_out !== undefined && (
          <span
            className="text-muted-foreground text-xs max-sm:hidden"
            title="You stopped speaking → first reply audio"
          >
            reply in {(call.lastTurn.ms.first_audio_out / 1000).toFixed(1)} s
          </span>
        )}
        {call?.speech && (
          <span className="text-muted-foreground text-xs max-md:hidden">
            speech: {speechLabel(call.speech.stt)} / {speechLabel(call.speech.tts)}
          </span>
        )}
        <span className="flex-1" />
        {here && mine && (
          <Button
            variant="ghost"
            size="icon"
            data-testid="call-mute"
            aria-pressed={mine.muted}
            aria-label={mine.muted ? "Unmute" : "Mute"}
            onClick={toggleMute}
          >
            {mine.muted ? <MicOff className="size-4 text-destructive" /> : <Mic className="size-4" />}
          </Button>
        )}
        <Button
          variant="destructive"
          size="sm"
          data-testid="call-hangup"
          onClick={() => (here || !call ? hangUp() : hangUpRemote(call.id)).catch(() => {})}
        >
          <PhoneOff className="size-4" />
          Hang up
        </Button>
      </div>
      {call && <LiveTranscript agent={agent} since={call.startedAt} />}
    </div>
  );
}

function speechLabel(s: string): string {
  if (s === "cpu") return "CPU";
  return /127\.0\.0\.1:840[12]/.test(s) ? "GPU" : s.replace(/^https?:\/\//, "");
}

function Timer({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.floor((now - since) / 1000));
  return (
    <span data-testid="call-timer" className="text-muted-foreground text-xs tabular-nums">
      {Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")}
    </span>
  );
}

/** The last exchange of this call, live (the DM below has the full transcript). */
function LiveTranscript({ agent, since }: { agent: AgentView; since: number }) {
  const messages = useMessages(agent.conversationId).data?.messages ?? [];
  const lines = messages
    .filter((m): m is Extract<Message, { kind: "voice_transcript" }> => m.kind === "voice_transcript")
    .filter((m) => m.createdAt >= since - 1000)
    .slice(-2);
  if (!lines.length) {
    return <p className="mt-1 text-muted-foreground text-xs">Say something. {agent.name} is listening.</p>;
  }
  return (
    <div data-testid="call-transcript" className="mt-1 space-y-0.5 text-xs">
      {lines.map((m) => (
        <p key={m.id} className="truncate">
          <span className="text-muted-foreground">{m.role === "user" ? "You" : agent.name}: </span>
          {m.text}
          {m.status === "cancelled" && <span className="text-muted-foreground"> (interrupted)</span>}
        </p>
      ))}
    </div>
  );
}

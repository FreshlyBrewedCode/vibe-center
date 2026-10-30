import { useNavigate } from "@tanstack/react-router";
import type { AgentView, Call, CallState, Message } from "@vibe-center/shared";
import {
  AudioLines,
  ChevronDown,
  MessageSquare,
  Mic,
  MicOff,
  Phone,
  PhoneOff,
  ShieldAlert,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useIsMobile } from "@/lib/media";
import { useCalls, useMe, useMessages, useVoiceStatus } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { AgentAvatar } from "../agent-avatar";
import { PermissionButtons } from "../dm/message-item";
import { hangUp, setMuted, startCall, useLocalCall } from "./call-client";

/** The active call with this agent, if any (on any device). */
export function useAgentCall(agentId: string): Call | null {
  return useCalls().data?.find((c) => c.agentId === agentId) ?? null;
}

type PermissionMessage = Extract<Message, { kind: "permission" }>;

/** The agent's latest unanswered permission request, if any (a call can't approve by voice). */
export function usePendingPermission(conversationId: string | undefined): PermissionMessage | null {
  const messages = useMessages(conversationId ?? "", { enabled: !!conversationId }).data?.messages;
  return (
    (messages?.findLast((m) => m.kind === "permission" && m.status === "pending") as PermissionMessage) ??
    null
  );
}

/** Hang-up and mute go through the server; say so when it couldn't be reached. */
export function reportFailure(what: string) {
  return (e: Error) => toast.error(`Couldn't ${what}: ${e.message}`);
}

/** DM header button: starts a call with the agent. Hidden while a call with it runs. */
export function CallButton({ agent }: { agent: AgentView }) {
  const status = useVoiceStatus();
  const call = useAgentCall(agent.id);
  const local = useLocalCall();
  const navigate = useNavigate();
  const mobile = useIsMobile();
  const starting =
    local?.agentId === agent.id && (local.phase === "starting" || local.phase === "connecting");
  if (call || starting) return null;
  const worker = status.data?.worker;
  const ready = worker?.state === "ok";
  const button = (
    <Button
      variant={mobile ? "ghost" : "outline"}
      size={mobile ? "round" : "pill"}
      data-testid="call-button"
      aria-label="Call"
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
      {!mobile && "Call"}
    </Button>
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">{button}</span>
      </TooltipTrigger>
      <TooltipContent>
        {ready
          ? `Voice call with ${agent.name}`
          : `Voice is offline: ${worker?.message ?? "checking…"} (Settings → Voice)`}
      </TooltipContent>
    </Tooltip>
  );
}

export const stateLabel: Record<CallState, string> = {
  connecting: "Connecting…",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
  ended: "Ended",
};

/**
 * Elapsed time since `since`, ticking every second, in tabular figures. Only the call UI's own
 * timer carries the `call-timer` test id; the header and the sheet pass `testId={null}`.
 */
export function CallTimer({
  since,
  className,
  testId = "call-timer",
}: {
  since: number;
  className?: string;
  testId?: string | null;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.floor((now - since) / 1000));
  return (
    <span
      data-testid={testId ?? undefined}
      className={cn("text-muted-foreground text-xs tabular-nums", className)}
    >
      {Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")}
    </span>
  );
}

/** Everything the call UI needs to know, computed once for the card, the strip and the sheet. */
interface CallView {
  agent: AgentView;
  call: Call | null;
  state: CallState;
  permission: PermissionMessage | null;
  /** The RTCPeerConnection lives only in the tab that started the call. */
  holdsAudio: boolean;
  /** The call's audio is on this device (maybe another tab), not another one. */
  here: boolean;
  muted: boolean;
}

/**
 * The call with this agent, while it runs: desktop gets a floating card over the thread, the
 * phone a compact strip under the header that opens the full-screen call sheet. The controls
 * work from any tab or device through the server; only the tab that started the call holds the
 * audio. Rendered once per DM (routes/_app/agents/$agentId/index.tsx).
 */
export function CallUi({ agent }: { agent: AgentView }) {
  const call = useAgentCall(agent.id);
  const local = useLocalCall();
  const me = useMe();
  const mobile = useIsMobile();
  const permission = usePendingPermission(call ? agent.conversationId : undefined);
  const mine = local?.agentId === agent.id ? local : null;
  const starting = mine && (mine.phase === "starting" || mine.phase === "connecting");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    if (mine?.phase === "ended" && mine.error) toast.error(`Call ended: ${mine.error}`);
  }, [mine?.phase, mine?.error]);

  if (!call && !starting) return null;
  // Any other tab, on this device or another, shows the call and controls it through the server.
  const view: CallView = {
    agent,
    call,
    state: call?.state ?? "connecting",
    permission,
    holdsAudio: !call || local?.callId === call.id,
    here: !call || call.deviceId === me.data?.id,
    muted: call?.muted ?? false,
  };
  if (mobile) {
    return (
      <>
        <CallStrip view={view} onOpen={() => setSheetOpen(true)} />
        {sheetOpen && <CallSheet view={view} onClose={() => setSheetOpen(false)} />}
      </>
    );
  }
  if (hidden) {
    return (
      <button
        type="button"
        data-testid="call-pill"
        onClick={() => setHidden(false)}
        className="elev absolute top-[68px] right-5 z-20 flex animate-vc-pop items-center gap-2 rounded-full border border-line-strong bg-card py-1.5 pr-3.5 pl-2.5 text-xs"
      >
        <span
          className={cn(
            "size-2 animate-vc-pulse rounded-full",
            permission ? "bg-presence-waiting" : "bg-call",
          )}
        />
        {call && <CallTimer since={call.startedAt} className="text-foreground" testId={null} />}
        <span className="text-muted-foreground">Show call</span>
      </button>
    );
  }
  return <CallCard view={view} onHide={() => setHidden(true)} />;
}

function speechLabel(s: string): string {
  if (s === "cpu") return "CPU";
  return /127\.0\.0\.1:840[12]/.test(s) ? "GPU" : s.replace(/^https?:\/\//, "");
}

/** The state line: amber shield while waiting for approval, else the state in the call colour. */
function StateLine({ view, className }: { view: CallView; className?: string }) {
  const waiting = !!view.permission;
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5 font-medium text-[12.5px]",
        waiting ? "text-presence-waiting" : "text-call",
        className,
      )}
    >
      {waiting ? (
        <ShieldAlert className="size-3.5 shrink-0" />
      ) : (
        <AudioLines className={cn("size-3.5 shrink-0", view.state !== "connecting" && "animate-vc-pulse")} />
      )}
      <span data-testid="call-state" className="truncate">
        {stateLabel[view.state]}
      </span>
      {waiting && <span className="truncate">· waiting for approval</span>}
    </span>
  );
}

/** The last exchange of this call, live (the DM below has the full transcript). */
function useTranscript(view: CallView, count: number) {
  const messages = useMessages(view.agent.conversationId).data?.messages ?? [];
  const since = view.call?.startedAt ?? Date.now();
  return messages
    .filter((m): m is Extract<Message, { kind: "voice_transcript" }> => m.kind === "voice_transcript")
    .filter((m) => m.createdAt >= since - 1000)
    .slice(-count);
}

function Transcript({ view, count, className }: { view: CallView; count: number; className?: string }) {
  const lines = useTranscript(view, count);
  if (!lines.length) {
    return (
      <p className={cn("text-muted-foreground text-[12.5px]", className)}>
        Say something. {view.agent.name} is listening.
      </p>
    );
  }
  return (
    <div data-testid="call-transcript" className={cn("space-y-1 text-[12.5px]", className)}>
      {lines.map((m) => (
        <p
          key={m.id}
          className={cn("truncate", m.role === "user" ? "text-muted-foreground" : "text-foreground")}
        >
          <span className="mr-1.5 text-muted-foreground">{m.role === "user" ? "You" : view.agent.name}</span>
          {m.text}
          {(m.status === "cancelled" || m.data?.interrupted) && (
            <span className="text-muted-foreground"> (interrupted)</span>
          )}
        </p>
      ))}
    </div>
  );
}

/** Where the audio is, when not here, with the way to bring it over. */
function Elsewhere({ view, className }: { view: CallView; className?: string }) {
  if (view.holdsAudio || !view.call) return null;
  return (
    <div
      data-testid="call-elsewhere"
      className={cn("flex items-center gap-2 text-muted-foreground text-xs", className)}
    >
      <span className="min-w-0 flex-1">
        {view.here
          ? "The audio isn't in this tab (another tab, or this one was reloaded)."
          : "The audio is on another device."}
      </span>
      <Button
        variant="outline"
        size="xs"
        onClick={() => startCall(view.agent.id).catch(reportFailure("move the call here"))}
      >
        Move audio here
      </Button>
    </div>
  );
}

/** Latency of the last turn and the speech backends: a quiet diagnostic line. */
function Diagnostics({ view, className }: { view: CallView; className?: string }) {
  const call = view.call;
  if (!call) return null;
  const parts: string[] = [];
  if (call.lastTurn?.ms.first_audio_out !== undefined) {
    parts.push(`reply in ${(call.lastTurn.ms.first_audio_out / 1000).toFixed(1)} s`);
  }
  if (call.speech) parts.push(`speech ${speechLabel(call.speech.stt)} / ${speechLabel(call.speech.tts)}`);
  if (!parts.length) return null;
  return (
    <p
      className={cn("truncate text-2xs text-muted-foreground", className)}
      title="You stopped speaking → first reply audio"
    >
      {parts.join(" · ")}
    </p>
  );
}

/** The pending approval, inside the call UI, so a voice session never needs the thread. */
function Approval({ view, compact = false }: { view: CallView; compact?: boolean }) {
  if (!view.permission) return null;
  return (
    <div
      data-testid="call-permission"
      className={cn(
        "overflow-hidden rounded-[14px] border bg-card",
        compact ? "border-line" : "border-presence-waiting/40",
      )}
      style={
        compact
          ? undefined
          : { boxShadow: "0 0 0 3px color-mix(in oklab, var(--presence-waiting) 10%, transparent)" }
      }
    >
      <div className={cn("flex items-center gap-2 text-sm", compact ? "px-3.5 pt-3" : "px-4 pt-3.5")}>
        <ShieldAlert className="size-4 shrink-0 text-presence-waiting" />
        <span className="font-semibold">{view.agent.name} needs approval</span>
      </div>
      <code
        className={cn(
          "mt-2.5 block whitespace-pre-wrap rounded-[8px] bg-background px-3 py-2 font-mono text-[12.5px] leading-snug",
          compact ? "mx-3.5" : "mx-4",
        )}
      >
        {view.permission.data.title}
      </code>
      <div className={compact ? "p-3.5" : "p-4"}>
        <PermissionButtons message={view.permission} />
      </div>
    </div>
  );
}

function Controls({
  view,
  size,
  labels = false,
  extra,
}: {
  view: CallView;
  size: "round" | "round-lg";
  labels?: boolean;
  extra?: { icon: ReactNode; label: string; onClick: () => void };
}) {
  const call = view.call;
  const control = (label: string, node: ReactNode) =>
    labels ? (
      <span key={label} className="flex flex-col items-center gap-2 text-muted-foreground text-xs">
        {node}
        {label}
      </span>
    ) : (
      node
    );
  return (
    <>
      {control(
        view.muted ? "unmute" : "mute",
        <Button
          key="mute"
          variant="soft"
          size={size}
          data-testid="call-mute"
          aria-pressed={view.muted}
          aria-label={view.muted ? "Unmute" : "Mute"}
          disabled={!call}
          className={cn(view.muted && "bg-destructive/15 text-destructive hover:bg-destructive/20")}
          onClick={() => call && setMuted(call.id, !call.muted).catch(reportFailure("mute the call"))}
        >
          {view.muted ? <MicOff /> : <Mic />}
        </Button>,
      )}
      {extra &&
        control(
          extra.label,
          <Button key="extra" variant="soft" size={size} aria-label={extra.label} onClick={extra.onClick}>
            {extra.icon}
          </Button>,
        )}
      {control(
        "end",
        <Button
          key="hangup"
          variant="destructive"
          size={size}
          data-testid="call-hangup"
          aria-label="Hang up"
          onClick={() => hangUp(call?.id ?? null).catch(reportFailure("hang up"))}
        >
          <PhoneOff />
        </Button>,
      )}
    </>
  );
}

/** Desktop: a 320px card floating top-right over the thread (elevation 3). */
function CallCard({ view, onHide }: { view: CallView; onHide: () => void }) {
  const { agent, call, permission } = view;
  return (
    <div
      data-testid="call-bar"
      className="elev absolute top-[68px] right-5 z-20 w-[320px] max-w-[calc(100%-2.5rem)] animate-vc-pop overflow-hidden rounded-[20px] border border-line-strong bg-card"
    >
      <div className="flex items-center gap-3 px-4 pt-4">
        <AgentAvatar
          avatar={agent.avatar}
          presence={permission ? "waiting" : "in_call"}
          size={44}
          surface="var(--card)"
        />
        <span className="min-w-0 flex-1 leading-tight">
          <span className="flex items-center justify-between font-semibold text-[15px]">
            <span className="truncate">{agent.name}</span>
            {call && <CallTimer since={call.startedAt} className="text-[12.5px]" />}
          </span>
          <StateLine view={view} className="mt-1" />
        </span>
      </div>
      <div className="mt-3 space-y-1.5 px-4">
        {call?.waiting?.reason === "busy" && !permission ? (
          <p className="text-muted-foreground text-[12.5px]">{agent.name} is finishing other work first.</p>
        ) : (
          <Transcript view={view} count={2} />
        )}
        <Diagnostics view={view} />
        <Elsewhere view={view} />
      </div>
      {permission && (
        <div className="mt-3 border-line border-t bg-background/40 p-3">
          <Approval view={view} compact />
        </div>
      )}
      <div className="mt-3 flex items-center justify-center gap-3 border-line border-t px-4 py-3">
        <Controls
          view={view}
          size="round"
          extra={{ icon: <MessageSquare />, label: "Hide call card", onClick: onHide }}
        />
      </div>
    </div>
  );
}

/** Phone: a compact strip under the DM header; tapping it opens the call sheet. */
function CallStrip({ view, onOpen }: { view: CallView; onOpen: () => void }) {
  const { call, permission } = view;
  return (
    <div data-testid="call-bar" className="shrink-0 border-line border-b px-3 pt-2 pb-2">
      <div className="elev-sm flex items-center gap-3 rounded-[14px] border border-line-strong bg-card py-2 pr-2 pl-3">
        <button
          type="button"
          aria-label="Open the call"
          onClick={onOpen}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <span
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-full",
              permission ? "bg-presence-waiting/15 text-presence-waiting" : "bg-call/15 text-call",
            )}
          >
            {permission ? (
              <ShieldAlert className="size-4" />
            ) : (
              <AudioLines className="size-4 animate-vc-pulse" />
            )}
          </span>
          <span className="min-w-0 flex-1 leading-tight">
            <span className="block truncate font-semibold text-sm">
              {permission ? (
                "Waiting for your approval"
              ) : (
                <span data-testid="call-state">{stateLabel[view.state]}</span>
              )}
            </span>
            <span className="block truncate text-muted-foreground text-xs">
              {call && <CallTimer since={call.startedAt} />}
              {call && " · "}Tap to open the call
            </span>
          </span>
        </button>
        <Controls view={view} size="round" />
      </div>
      <Elsewhere view={view} className="px-1 pt-2" />
    </div>
  );
}

/** Phone: the full-screen call (a bottom sheet) with the transcript, approval and 64px controls. */
function CallSheet({ view, onClose }: { view: CallView; onClose: () => void }) {
  const { agent, call, permission } = view;
  const lines = useTranscript(view, 6);
  return (
    <div
      role="dialog"
      aria-label={`Call with ${agent.name}`}
      className="fixed inset-0 z-40 flex animate-vc-sheet flex-col bg-background pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-foreground"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-1/2"
        style={{
          background: `radial-gradient(60% 55% at 50% 20%, color-mix(in oklab, ${agent.avatar.color} 16%, transparent), transparent)`,
        }}
      />
      <div className="relative flex items-center justify-between px-3 pt-1 text-[15px]">
        <button
          type="button"
          onClick={onClose}
          className="flex h-10 items-center gap-1 rounded-full px-2 text-muted-foreground"
        >
          <ChevronDown className="size-5" /> Chat
        </button>
        {call && <CallTimer since={call.startedAt} className="pr-2 text-[15px]" testId={null} />}
      </div>
      <div className="vc-noscroll relative flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-5">
        <div className="mt-8 flex flex-col items-center">
          <AgentAvatar avatar={agent.avatar} presence={permission ? "waiting" : "in_call"} size={112} />
          <span className="mt-6 font-semibold text-3xl tracking-tight">{agent.name}</span>
          <span
            className={cn(
              "mt-2.5 inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 font-medium text-[14px]",
              permission
                ? "border-presence-waiting/30 bg-presence-waiting/10 text-presence-waiting"
                : "border-call/30 bg-call/10 text-call",
            )}
          >
            {permission ? (
              <ShieldAlert className="size-4" />
            ) : (
              <AudioLines className="size-4 animate-vc-pulse" />
            )}
            {permission ? "Waiting for approval" : stateLabel[view.state]}
          </span>
        </div>
        <div className="mt-7 w-full space-y-2 text-[15.5px] leading-[1.4]">
          {lines.length === 0 && !permission && (
            <p className="text-center text-muted-foreground">Say something. {agent.name} is listening.</p>
          )}
          {lines.map((m) => (
            <p
              key={m.id}
              className={m.role === "user" ? "text-right text-muted-foreground" : "text-foreground"}
            >
              {m.text}
              {(m.status === "cancelled" || m.data?.interrupted) && (
                <span className="text-muted-foreground"> (interrupted)</span>
              )}
            </p>
          ))}
          {call?.waiting?.reason === "busy" && !permission && (
            <p className="text-center text-muted-foreground text-sm">
              {agent.name} is finishing other work first.
            </p>
          )}
        </div>
        {permission && (
          <div className="mt-5 w-full">
            <Approval view={view} />
          </div>
        )}
        <div className="mt-4 w-full space-y-2">
          <Elsewhere view={view} />
          <Diagnostics view={view} className="text-center" />
        </div>
      </div>
      <div className="relative mb-6 flex w-full items-start justify-around px-5 pt-4">
        <Controls
          view={view}
          size="round-lg"
          labels
          extra={{ icon: <MessageSquare />, label: "chat", onClick: onClose }}
        />
      </div>
    </div>
  );
}

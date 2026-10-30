import { Link } from "@tanstack/react-router";
import { PhoneOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAgent, useCalls, useMe } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { AgentAvatar } from "../agent-avatar";
import { stateDot, stateLabel } from "./call";
import { hangUp, hangUpRemote, useLocalCall } from "./call-client";

/**
 * A call keeps running when you leave its DM (one call at a time, see ARCHITECTURE's "known
 * gaps"). This shows it everywhere else: sidebar and mobile top bar, with hang-up and a link back
 * to the DM. `exceptAgentId` hides it where the DM's own `CallBar` already shows the same call.
 */
export function GlobalCallIndicator({
  exceptAgentId,
  onNavigate,
  compact = false,
  className,
}: {
  exceptAgentId?: string;
  onNavigate?: () => void;
  compact?: boolean;
  className?: string;
}) {
  const call = useCalls().data?.[0];
  const me = useMe();
  const local = useLocalCall();
  const agent = useAgent(call?.agentId ?? "");
  if (!call || !agent || call.agentId === exceptAgentId) return null;
  const here = call.deviceId === me.data?.id;
  // The RTCPeerConnection lives only in the tab that started the call; every other tab (even on
  // the same device, which shares the cookie) must end it through the server instead.
  const holdsSession = local?.callId === call.id;
  return (
    <div
      data-testid="global-call-indicator"
      className={cn(
        "flex items-center gap-2 border-t px-3 py-2",
        compact ? "max-md:justify-center max-md:px-0" : "",
        className,
      )}
    >
      <Link
        to="/agents/$agentId"
        params={{ agentId: agent.id }}
        onClick={onNavigate}
        className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden"
      >
        <span className="relative shrink-0">
          <AgentAvatar avatar={agent.avatar} size="sm" />
          <span
            className={cn(
              "-right-0.5 -bottom-0.5 absolute size-2.5 rounded-full ring-2 ring-sidebar",
              stateDot[call.state],
            )}
          />
        </span>
        <span className={cn("min-w-0 flex-1", compact && "max-md:hidden")}>
          <span className="block truncate font-medium text-sm leading-tight">{agent.name}</span>
          <span className="block truncate text-muted-foreground text-xs leading-tight">
            {here ? stateLabel[call.state] : "On another device"}
          </span>
        </span>
      </Link>
      <Button
        variant="ghost"
        size="icon"
        className="size-7 shrink-0"
        aria-label="Hang up"
        onClick={() => (holdsSession ? hangUp() : hangUpRemote(call.id)).catch(() => {})}
      >
        <PhoneOff className="size-4 text-destructive" />
      </Button>
    </div>
  );
}

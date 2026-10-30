import { Link } from "@tanstack/react-router";
import { PhoneOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAgent, useCalls, useMe } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { AgentAvatar } from "../agent-avatar";
import { reportFailure, stateDot, stateLabel, usePendingPermission } from "./call";
import { hangUp, useLocalCall } from "./call-client";

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
  const shown = !!call && !!agent && call.agentId !== exceptAgentId;
  const permission = usePendingPermission(shown ? agent.conversationId : undefined);
  if (!shown) return null;
  // The audio lives only in the tab that started the call; hang-up works from anywhere.
  const status = permission
    ? "Needs your approval"
    : local?.callId === call.id
      ? stateLabel[call.state]
      : call.deviceId === me.data?.id
        ? `${stateLabel[call.state]} · audio in another tab`
        : "On another device";
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
          <span
            className={cn(
              "block truncate text-xs leading-tight",
              permission ? "font-medium text-foreground" : "text-muted-foreground",
            )}
          >
            {status}
          </span>
        </span>
      </Link>
      <Button
        variant="ghost"
        size="icon"
        className="size-7 shrink-0"
        aria-label="Hang up"
        onClick={() => hangUp(call.id).catch(reportFailure("hang up"))}
      >
        <PhoneOff className="size-4 text-destructive" />
      </Button>
    </div>
  );
}

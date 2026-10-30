import { Link } from "@tanstack/react-router";
import { PhoneOff, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAgent, useCalls, useMe } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { AgentAvatar } from "../agent-avatar";
import { CallTimer, reportFailure, stateLabel, usePendingPermission } from "./call";
import { hangUp, useLocalCall } from "./call-client";

/**
 * A call keeps running when you leave its DM (one call at a time, see ARCHITECTURE's "known
 * gaps"). This shows it everywhere else: the sidebar (rail or list) and, on the phone, a strip
 * above the current screen, each with a link back to the DM and hang-up. `exceptAgentId` hides it
 * where the DM's own call UI already shows the same call.
 */
export function GlobalCallIndicator({
  exceptAgentId,
  variant,
}: {
  exceptAgentId?: string;
  variant: "rail" | "list" | "mobile";
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
  const presence = permission ? "waiting" : "in_call";
  const hangup = (
    <Button
      variant="destructive"
      size={variant === "rail" ? "icon-xs" : "icon-sm"}
      className="shrink-0 rounded-full"
      aria-label="Hang up"
      onClick={() => hangUp(call.id).catch(reportFailure("hang up"))}
    >
      <PhoneOff className={variant === "rail" ? "size-3" : "size-3.5"} />
    </Button>
  );

  if (variant === "rail") {
    return (
      <div
        data-testid="global-call-indicator"
        className="mx-2 flex flex-col items-center gap-1.5 rounded-[14px] border border-line bg-card py-2"
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <Link to="/agents/$agentId" params={{ agentId: agent.id }} className="rounded-full">
              <AgentAvatar avatar={agent.avatar} presence={presence} size={30} surface="var(--card)" />
              <span className="sr-only">
                {agent.name}: {status}
              </span>
            </Link>
          </TooltipTrigger>
          <TooltipContent side="right" className="px-3 py-2">
            <span className="font-semibold">{agent.name}</span>
            <span className={cn("ml-2", permission ? "text-presence-waiting" : "text-call")}>{status}</span>
          </TooltipContent>
        </Tooltip>
        <CallTimer since={call.startedAt} className="text-2xs" testId={null} />
        {hangup}
      </div>
    );
  }

  return (
    <div
      data-testid="global-call-indicator"
      className={cn(
        "flex items-center gap-3 border-line bg-card",
        variant === "list" ? "mx-2 rounded-[14px] border py-2 pr-2 pl-2.5" : "border-b px-3 py-2",
      )}
    >
      <Link
        to="/agents/$agentId"
        params={{ agentId: agent.id }}
        className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden"
      >
        <AgentAvatar avatar={agent.avatar} presence={presence} size={32} surface="var(--card)" />
        <span className="min-w-0 flex-1 leading-tight">
          <span className="flex items-baseline gap-2">
            <span className="truncate font-medium text-sm">{agent.name}</span>
            <CallTimer since={call.startedAt} className="text-xs" testId={null} />
          </span>
          <span
            className={cn(
              "flex items-center gap-1 truncate text-xs",
              permission ? "font-medium text-presence-waiting" : "text-call",
            )}
          >
            {permission && <ShieldAlert className="size-3" />}
            {status}
          </span>
        </span>
      </Link>
      {hangup}
    </div>
  );
}

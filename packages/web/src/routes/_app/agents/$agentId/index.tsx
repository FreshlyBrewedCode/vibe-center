import { createFileRoute, Link } from "@tanstack/react-router";
import { Pencil, SquarePen } from "lucide-react";
import { useEffect } from "react";
import { toast } from "sonner";
import { AgentAvatar, presenceLabel } from "@/components/agent-avatar";
import { Composer } from "@/components/dm/composer";
import { MessageList } from "@/components/dm/message-list";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAgent, useAgents, useMarkRead, useMessages, useNewSession } from "@/lib/queries";

export const Route = createFileRoute("/_app/agents/$agentId/")({ component: DmPage });

function DmPage() {
  const { agentId } = Route.useParams();
  const agents = useAgents();
  const agent = useAgent(agentId);
  if (agents.isPending) return null;
  if (!agent) return <p className="p-6 text-muted-foreground text-sm">Agent not found.</p>;
  return <Dm key={agent.id} agent={agent} />;
}

function Dm({ agent }: { agent: NonNullable<ReturnType<typeof useAgent>> }) {
  const messages = useMessages(agent.conversationId);
  const newSession = useNewSession(agent.conversationId);
  const markRead = useMarkRead(agent.conversationId);
  const busy = agent.presence === "thinking" || agent.presence === "working" || agent.presence === "waiting";
  const lastSeq = messages.data?.messages.at(-1)?.seq ?? 0;

  // Reading the DM clears its unread badge (on every device, via the event channel).
  useEffect(() => {
    if (agent.unread > 0 && lastSeq > 0 && document.visibilityState === "visible") markRead.mutate(lastSeq);
  }, [agent.unread, lastSeq, markRead.mutate]);

  return (
    <>
      <header className="flex h-12 shrink-0 items-center gap-3 border-b px-4">
        <AgentAvatar avatar={agent.avatar} presence={agent.presence} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold text-sm">{agent.name}</div>
          <div data-testid="presence" className="truncate text-muted-foreground text-xs">
            {presenceLabel[agent.presence]}
            {agent.presenceDetail ? ` · ${agent.presenceDetail}` : ""}
          </div>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              disabled={newSession.isPending}
              onClick={() => newSession.mutate(undefined, { onError: (e) => toast.error(e.message) })}
            >
              <SquarePen className="size-4" />
              <span className="max-sm:hidden">New session</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Start a fresh harness session; history stays here</TooltipContent>
        </Tooltip>
        <Button asChild variant="ghost" size="icon" aria-label="Edit agent">
          <Link to="/agents/$agentId/edit" params={{ agentId: agent.id }}>
            <Pencil className="size-4" />
          </Link>
        </Button>
      </header>
      {messages.isError ? (
        <p className="flex-1 p-6 text-destructive text-sm">{messages.error.message}</p>
      ) : (
        <MessageList messages={messages.data?.messages ?? []} agent={agent} />
      )}
      <Composer conversationId={agent.conversationId} agentName={agent.name} busy={busy} />
    </>
  );
}

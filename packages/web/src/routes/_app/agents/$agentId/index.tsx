import { createFileRoute, Link } from "@tanstack/react-router";
import { Info, Pencil, SquarePen } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AgentAvatar, presenceLabel } from "@/components/agent-avatar";
import { DetailsPanel } from "@/components/details-panel";
import { Composer } from "@/components/dm/composer";
import { MessageList } from "@/components/dm/message-list";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CallBar, CallButton } from "@/components/voice/call";
import {
  ensureMessageLoaded,
  queryClient,
  useAgent,
  useAgents,
  useHarnesses,
  useMarkRead,
  useMessages,
  useNewSession,
} from "@/lib/queries";

export const Route = createFileRoute("/_app/agents/$agentId/")({
  validateSearch: (search: Record<string, unknown>): { at?: number } => ({
    at: typeof search.at === "number" ? search.at : undefined,
  }),
  component: DmPage,
});

function DmPage() {
  const { agentId } = Route.useParams();
  const { at } = Route.useSearch();
  const agents = useAgents();
  const agent = useAgent(agentId);
  if (agents.isPending) return null;
  if (!agent) return <p className="p-6 text-muted-foreground text-sm">Agent not found.</p>;
  return <Dm key={agent.id} agent={agent} jumpToSeq={at} />;
}

function Dm({ agent, jumpToSeq }: { agent: NonNullable<ReturnType<typeof useAgent>>; jumpToSeq?: number }) {
  const navigate = Route.useNavigate();
  const messages = useMessages(agent.conversationId);
  const harnesses = useHarnesses();
  const newSession = useNewSession(agent.conversationId);
  const markRead = useMarkRead(agent.conversationId);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [pendingJump, setPendingJump] = useState<number | null | undefined>(jumpToSeq);
  const busy = agent.presence === "thinking" || agent.presence === "working" || agent.presence === "waiting";
  const lastSeq = messages.data?.messages.at(-1)?.seq ?? 0;
  const harness = harnesses.data?.find((h) => h.id === agent.harnessId);
  const harnessDown =
    harness && (harness.health.status === "not_installed" || harness.health.status === "error")
      ? { message: harness.health.message ?? `${harness.name} is unavailable.` }
      : harness?.health.status === "auth_required"
        ? { message: `${harness.name} needs you to sign in.` }
        : null;

  // Reading the DM clears its unread badge (on every device, via the event channel).
  useEffect(() => {
    if (agent.unread > 0 && lastSeq > 0 && document.visibilityState === "visible") markRead.mutate(lastSeq);
  }, [agent.unread, lastSeq, markRead.mutate]);

  // A ⌘K search hit may point at a message outside the loaded window: fetch its page first.
  useEffect(() => {
    if (jumpToSeq == null) return;
    setPendingJump(null);
    void ensureMessageLoaded(queryClient, agent.conversationId, jumpToSeq).then(() =>
      setPendingJump(jumpToSeq),
    );
  }, [jumpToSeq, agent.conversationId]);

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-3 border-b px-4">
          {/* The agent's name already shows in the mobile top bar (MobileNav); avoid repeating it. */}
          <div className="hidden min-w-0 flex-1 items-center gap-3 sm:flex">
            <AgentAvatar avatar={agent.avatar} presence={agent.presence} />
            <div className="min-w-0 flex-1">
              <div className="truncate font-semibold text-sm">{agent.name}</div>
              <div data-testid="presence" className="truncate text-muted-foreground text-xs">
                {presenceLabel[agent.presence]}
                {agent.presenceDetail ? ` · ${agent.presenceDetail}` : ""}
              </div>
            </div>
          </div>
          <div className="flex-1 sm:hidden" />
          <CallButton agent={agent} />
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
          <Button
            variant={detailsOpen ? "secondary" : "ghost"}
            size="icon"
            aria-label="Agent details"
            onClick={() => setDetailsOpen((v) => !v)}
          >
            <Info className="size-4" />
          </Button>
        </header>
        <CallBar agent={agent} />
        {messages.isError ? (
          <p className="flex-1 p-6 text-destructive text-sm">{messages.error.message}</p>
        ) : (
          <MessageList
            conversationId={agent.conversationId}
            messages={messages.data?.messages ?? []}
            hasMore={messages.data?.hasMore ?? false}
            agent={agent}
            jumpToSeq={pendingJump}
            onJumpHandled={() => {
              setPendingJump(null);
              void navigate({ search: {}, replace: true });
            }}
          />
        )}
        <Composer
          conversationId={agent.conversationId}
          agentName={agent.name}
          busy={busy}
          harnessDown={harnessDown}
        />
      </div>
      {detailsOpen && <DetailsPanel agent={agent} onClose={() => setDetailsOpen(false)} />}
    </div>
  );
}

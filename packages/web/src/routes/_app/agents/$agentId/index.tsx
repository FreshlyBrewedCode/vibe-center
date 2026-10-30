import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronLeft, Info, MoreHorizontal, Pencil, SquarePen } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AgentAvatar, statusLine } from "@/components/agent-avatar";
import { DetailsPanel } from "@/components/details-panel";
import { Composer } from "@/components/dm/composer";
import { MessageList } from "@/components/dm/message-list";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CallButton, CallTimer, CallUi, useAgentCall } from "@/components/voice/call";
import { useIsMobile } from "@/lib/media";
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
import { cn } from "@/lib/utils";

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

type Agent = NonNullable<ReturnType<typeof useAgent>>;

function Dm({ agent, jumpToSeq }: { agent: Agent; jumpToSeq?: number }) {
  const navigate = Route.useNavigate();
  const messages = useMessages(agent.conversationId);
  const harnesses = useHarnesses();
  const markRead = useMarkRead(agent.conversationId);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [pendingJump, setPendingJump] = useState<number | null | undefined>(jumpToSeq);
  const busy = agent.presence === "thinking" || agent.presence === "working" || agent.presence === "waiting";
  const lastSeq = messages.data?.messages.at(-1)?.seq ?? 0;
  const harness = harnesses.data?.find((h) => h.id === agent.harnessId);
  // Only a confirmed-unusable harness (not installed, or auth missing) blocks sending. "error" is
  // often a stale or flaky probe (e.g. a timeout at boot); show it but let a real send try anyway.
  const harnessIssue =
    harness?.health.status === "not_installed"
      ? { message: harness.health.message ?? `${harness.name} is unavailable.`, blocking: true }
      : harness?.health.status === "auth_required"
        ? { message: `${harness.name} needs you to sign in.`, blocking: true }
        : harness?.health.status === "error"
          ? { message: harness.health.message ?? `${harness.name} had a problem.`, blocking: false }
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
    <div className="relative flex min-h-0 flex-1">
      <div className="relative flex min-w-0 flex-1 flex-col">
        <DmHeader
          agent={agent}
          harnessName={harness?.name}
          detailsOpen={detailsOpen}
          onToggleDetails={() => setDetailsOpen((v) => !v)}
        />
        {/* The call UI: a floating card over the thread on desktop; on the phone a strip under
            the header plus a full-screen sheet. Rendered here so the strip sits in the column. */}
        <CallUi agent={agent} />
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
          harnessId={agent.harnessId}
          busy={busy}
          harnessIssue={harnessIssue}
        />
      </div>
      {detailsOpen && <DetailsPanel agent={agent} onClose={() => setDetailsOpen(false)} />}
    </div>
  );
}

/**
 * Sticky 56px header. Phone: back chevron, avatar with the presence ring, name and state, Call,
 * Details and a "more" menu (new session, edit). Desktop: the same without the chevron, plus the
 * harness · model pill, and the actions as their own buttons.
 */
function DmHeader({
  agent,
  harnessName,
  detailsOpen,
  onToggleDetails,
}: {
  agent: Agent;
  harnessName?: string;
  detailsOpen: boolean;
  onToggleDetails: () => void;
}) {
  const mobile = useIsMobile();
  const call = useAgentCall(agent.id);
  const newSession = useNewSession(agent.conversationId);
  const s = statusLine(agent);
  const startSession = () => newSession.mutate(undefined, { onError: (e) => toast.error(e.message) });
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-line border-b bg-background/90 px-2 backdrop-blur sm:px-5">
      {mobile && (
        <Button asChild variant="ghost" size="round" className="-mr-1">
          <Link to="/" aria-label="Back to agents">
            <ChevronLeft className="size-6" />
          </Link>
        </Button>
      )}
      <AgentAvatar avatar={agent.avatar} presence={agent.presence} size={mobile ? 34 : 32} />
      <div className="min-w-0 flex-1 leading-tight">
        <div className="truncate font-semibold text-sm">{agent.name}</div>
        <div
          data-testid="presence"
          className={cn("flex items-center gap-1.5 truncate text-xs", call ? "text-call" : s.className)}
        >
          {call ? (
            <>
              <span className="size-1.5 shrink-0 animate-vc-pulse rounded-full bg-call" />
              <span className="truncate">In a call</span>
              <span aria-hidden>·</span>
              <CallTimer since={call.startedAt} className="text-call" />
            </>
          ) : (
            <span className="truncate">{s.text}</span>
          )}
        </div>
      </div>
      {!mobile && (harnessName || agent.model) && (
        <span className="mr-1 hidden items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-muted-foreground text-xs lg:flex">
          {[harnessName, agent.model].filter(Boolean).join(" · ")}
        </span>
      )}
      <CallButton agent={agent} />
      {mobile ? (
        <>
          <Button
            variant={detailsOpen ? "soft" : "ghost"}
            size="round"
            aria-label="Agent details"
            onClick={onToggleDetails}
          >
            <Info className="size-[18px]" />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="round" aria-label="More">
                <MoreHorizontal className="size-5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-44">
              <DropdownMenuItem disabled={newSession.isPending} onSelect={startSession}>
                <SquarePen /> New session
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link to="/agents/$agentId/edit" params={{ agentId: agent.id }}>
                  <Pencil /> Edit agent
                </Link>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      ) : (
        <>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="quiet"
                size="icon"
                aria-label="New session"
                disabled={newSession.isPending}
                onClick={startSession}
              >
                <SquarePen className="size-[18px]" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>New session: a fresh harness session; history stays here</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button asChild variant="quiet" size="icon">
                <Link to="/agents/$agentId/edit" params={{ agentId: agent.id }} aria-label="Edit agent">
                  <Pencil className="size-[18px]" />
                </Link>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Edit agent</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={detailsOpen ? "soft" : "quiet"}
                size="icon"
                aria-label="Agent details"
                aria-pressed={detailsOpen}
                onClick={onToggleDetails}
              >
                <Info className="size-[18px]" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Details</TooltipContent>
          </Tooltip>
        </>
      )}
    </header>
  );
}

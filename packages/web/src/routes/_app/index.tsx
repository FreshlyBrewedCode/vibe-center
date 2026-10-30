import { createFileRoute, Link } from "@tanstack/react-router";
import { Plus, Search, SquarePen } from "lucide-react";
import { AgentAvatar, statusLine } from "@/components/agent-avatar";
import { sortAgents } from "@/components/sidebar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useIsMobile } from "@/lib/media";
import { setPaletteOpen } from "@/lib/palette";
import { useAgents } from "@/lib/queries";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/")({ component: Home });

/** Desktop: a calm empty state next to the sidebar. Phone: the agent list is the home screen. */
function Home() {
  const mobile = useIsMobile();
  return mobile ? <MobileAgentList /> : <DesktopHome />;
}

function DesktopHome() {
  const agents = useAgents();
  const empty = agents.data?.length === 0;
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="flex max-w-sm flex-col items-center gap-4 text-center">
        <span className="flex size-12 items-center justify-center rounded-[14px] border border-line-strong bg-card font-semibold text-xl tracking-tight">
          V
        </span>
        <div className="space-y-1.5">
          <h1 className="font-semibold text-xl tracking-tight">
            {empty ? "Create your first agent" : "Pick an agent"}
          </h1>
          <p className="text-muted-foreground text-sm">
            Each agent is a persona on a coding harness (Claude Code, OpenCode, any ACP agent). Chat in its
            DM like with a colleague, or call it.
          </p>
        </div>
        {empty ? (
          <Button asChild>
            <Link to="/agents/new">
              <Plus /> New agent
            </Link>
          </Button>
        ) : (
          <p className="text-muted-foreground text-xs">
            <kbd>⌘K</kbd> jumps to any agent or message
          </p>
        )}
      </div>
    </div>
  );
}

function MobileAgentList() {
  const agents = useAgents();
  const sorted = agents.data ? sortAgents(agents.data) : [];
  const attention = sorted.filter((a) => a.presence === "waiting" || a.presence === "error").length;
  const unread = sorted.reduce((n, a) => n + a.unread, 0);
  const subtitle =
    attention > 0
      ? `${attention} need${attention === 1 ? "s" : ""} your attention`
      : unread > 0
        ? `${unread} unread`
        : sorted.length
          ? `${sorted.length} agent${sorted.length === 1 ? "" : "s"}`
          : "No agents yet";
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-end justify-between px-5 pt-3 pb-3">
        <div>
          <h1 className="font-bold text-3xl tracking-tight">Agents</h1>
          <p className="text-muted-foreground text-sm">{subtitle}</p>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="soft"
            size="round"
            className="bg-card"
            aria-label="Search"
            onClick={() => setPaletteOpen(true)}
          >
            <Search className="size-[18px]" />
          </Button>
          <Button asChild variant="soft" size="round" className="bg-card">
            <Link to="/agents/new" aria-label="New agent">
              <SquarePen className="size-[18px]" />
            </Link>
          </Button>
        </div>
      </header>
      <ul className="vc-noscroll min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {sorted.map((a) => {
          const s = statusLine(a);
          const text = a.presence === "idle" && a.description ? a.description : s.text;
          return (
            <li key={a.id}>
              <Link
                to="/agents/$agentId"
                params={{ agentId: a.id }}
                data-testid="agent-row"
                className="flex items-center gap-3.5 rounded-[14px] px-2.5 py-2.5 active:bg-muted/60"
              >
                <AgentAvatar avatar={a.avatar} presence={a.presence} size={48} />
                <span className="flex min-w-0 flex-1 flex-col border-line border-b pb-3 leading-tight">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className={cn("truncate text-[16.5px]", a.unread ? "font-semibold" : "font-medium")}>
                      {a.name}
                    </span>
                  </span>
                  <span className="mt-1 flex items-center gap-2">
                    <span className={cn("line-clamp-1 flex-1 text-[14px]", s.className)}>{text}</span>
                    {a.unread > 0 && (
                      <Badge data-testid="unread" className="h-5 min-w-5 px-1.5 text-xs">
                        {a.unread}
                      </Badge>
                    )}
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
        <li>
          <Link
            to="/agents/new"
            className="flex items-center gap-3.5 px-2.5 py-3 text-[15px] text-muted-foreground"
          >
            <span className="flex size-12 items-center justify-center rounded-full border border-line-strong border-dashed">
              <Plus className="size-5" />
            </span>
            New agent
          </Link>
        </li>
        {agents.data?.length === 0 && (
          <li className="px-3 pt-6 text-center text-muted-foreground text-sm">
            Create your first agent: a persona on a coding harness you chat with in a DM, or call.
          </li>
        )}
      </ul>
    </div>
  );
}

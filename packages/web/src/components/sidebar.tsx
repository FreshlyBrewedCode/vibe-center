import { Link, useRouterState } from "@tanstack/react-router";
import type { AgentView } from "@vibe-center/shared";
import { Brain, Plus, Search, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConnectionState } from "@/lib/events";
import { setPaletteOpen } from "@/lib/palette";
import { useAgents } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { AgentAvatar } from "./agent-avatar";
import { GlobalCallIndicator } from "./voice/call-indicator";

const URGENT = new Set<AgentView["presence"]>(["waiting", "error"]);
const BUSY = new Set<AgentView["presence"]>(["thinking", "working", "in_call"]);

/** Unread and agents needing attention float to the top; otherwise alphabetical. */
function sortAgents(agents: AgentView[]): AgentView[] {
  const rank = (a: AgentView) => (a.unread > 0 || URGENT.has(a.presence) ? 0 : BUSY.has(a.presence) ? 1 : 2);
  return [...agents].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/** The persistent desktop rail; hidden below `sm`, where `MobileNav`'s drawer takes over. */
export function Sidebar() {
  return (
    <nav className="hidden w-64 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground sm:flex max-md:w-20">
      <SidebarContent compact />
    </nav>
  );
}

/**
 * Shared between the desktop rail and the mobile drawer. `compact` is for the persistent rail,
 * which goes icon-only between the `sm` and `md` breakpoints; the drawer is always full width
 * (it overlays the whole screen), so it passes `compact={false}` and always shows labels,
 * independent of the viewport's own width.
 */
export function SidebarContent({
  onNavigate,
  compact = false,
}: {
  onNavigate?: () => void;
  compact?: boolean;
}) {
  const agents = useAgents();
  const connection = useConnectionState();
  const sorted = agents.data ? sortAgents(agents.data) : undefined;
  const activeAgentId = useRouterState({
    select: (s) => /^\/agents\/([^/]+)/.exec(s.location.pathname)?.[1],
  });
  const hideLabel = compact ? "max-md:hidden" : "";
  return (
    <>
      <div className="flex h-12 items-center justify-between px-3">
        <Link to="/" className={cn("font-semibold", hideLabel)} onClick={onNavigate}>
          Vibe Center
        </Link>
        <span
          title={connection === "open" ? "Live" : "Reconnecting…"}
          className={cn(
            "size-2 rounded-full",
            connection === "open" ? "bg-presence-working" : "bg-presence-waiting",
          )}
        />
      </div>
      <div className="px-3 pb-1">
        <Button
          variant="outline"
          size="sm"
          className={cn(
            "w-full justify-start gap-2 text-muted-foreground",
            compact && "max-md:justify-center max-md:px-0",
          )}
          onClick={() => {
            onNavigate?.();
            setPaletteOpen(true);
          }}
        >
          <Search className="size-3.5" />
          <span className={hideLabel}>Search…</span>
          <kbd className="ml-auto hidden rounded border bg-muted px-1 font-mono text-[10px] lg:inline">
            ⌘K
          </kbd>
        </Button>
      </div>
      <div className="flex items-center justify-between px-3 pt-2 pb-1 text-muted-foreground text-xs">
        <span className={hideLabel}>Agents</span>
        <Button asChild variant="ghost" size="icon" className="size-6" aria-label="New agent">
          <Link to="/agents/new" onClick={onNavigate}>
            <Plus className="size-4" />
          </Link>
        </Button>
      </div>
      <ul className="flex-1 space-y-0.5 overflow-y-auto px-2">
        {sorted?.map((a) => (
          <li key={a.id}>
            <Link
              to="/agents/$agentId"
              params={{ agentId: a.id }}
              onClick={onNavigate}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-sidebar-accent"
              activeProps={{ className: "bg-sidebar-accent font-medium" }}
              data-testid="sidebar-agent"
            >
              <AgentAvatar avatar={a.avatar} presence={a.presence} size="sm" />
              <span className={cn("flex-1 truncate", hideLabel, a.unread > 0 && "font-semibold")}>
                {a.name}
              </span>
              {a.unread > 0 && (
                <span
                  data-testid="unread"
                  className="rounded-full bg-primary px-1.5 font-medium text-[10px] text-primary-foreground"
                >
                  {a.unread}
                </span>
              )}
            </Link>
          </li>
        ))}
      </ul>
      <GlobalCallIndicator exceptAgentId={activeAgentId} onNavigate={onNavigate} compact={compact} />
      <div className="border-t p-2">
        <Link
          to="/memories"
          onClick={onNavigate}
          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-sidebar-accent"
          activeProps={{ className: "bg-sidebar-accent" }}
        >
          <Brain className="size-4" />
          <span className={hideLabel}>Memories</span>
        </Link>
        <Link
          to="/settings"
          onClick={onNavigate}
          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-sidebar-accent"
          activeProps={{ className: "bg-sidebar-accent" }}
        >
          <Settings className="size-4" />
          <span className={hideLabel}>Settings</span>
        </Link>
      </div>
    </>
  );
}

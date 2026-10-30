import { Link, useRouterState } from "@tanstack/react-router";
import type { AgentView } from "@vibe-center/shared";
import { Brain, PanelLeftClose, PanelLeftOpen, Plug, Plus, Search, Settings } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useConnectionState } from "@/lib/events";
import { setPaletteOpen } from "@/lib/palette";
import { useAgents, useMe } from "@/lib/queries";
import { toggleSidebar, useSidebarMode } from "@/lib/sidebar";
import { cn } from "@/lib/utils";
import { AgentAvatar, statusLine, UserAvatar } from "./agent-avatar";
import { GlobalCallIndicator } from "./voice/call-indicator";

const URGENT = new Set<AgentView["presence"]>(["waiting", "error"]);
const BUSY = new Set<AgentView["presence"]>(["thinking", "working", "in_call"]);

/** Unread and agents needing attention float to the top; otherwise alphabetical. */
export function sortAgents(agents: AgentView[]): AgentView[] {
  const rank = (a: AgentView) => (a.unread > 0 || URGENT.has(a.presence) ? 0 : BUSY.has(a.presence) ? 1 : 2);
  return [...agents].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

const BOTTOM: { to: "/memories" | "/settings/mcp" | "/settings"; icon: typeof Brain; label: string }[] = [
  { to: "/memories", icon: Brain, label: "Memories" },
  { to: "/settings/mcp", icon: Plug, label: "MCP servers" },
  { to: "/settings", icon: Settings, label: "Settings" },
];

/** The wordmark tile. */
export function Mark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-[8px] border border-line-strong bg-card font-semibold text-[13px] text-foreground tracking-tight",
        className,
      )}
    >
      V
    </span>
  );
}

/**
 * The desktop sidebar (hidden below `sm`, where the agent list is its own screen): a 64px icon
 * rail of presence-ringed avatars, or the 272px list with names and status lines. ⌘\ toggles;
 * the choice is remembered (lib/sidebar.ts).
 */
export function Sidebar() {
  const mode = useSidebarMode();
  return (
    <nav
      aria-label="Agents"
      data-mode={mode}
      className={cn(
        "relative hidden shrink-0 flex-col border-line border-r bg-sidebar text-sidebar-foreground transition-[width] duration-[220ms] ease-out sm:flex",
        mode === "rail" ? "w-16" : "w-[272px]",
      )}
    >
      {mode === "rail" ? <Rail /> : <Expanded />}
    </nav>
  );
}

function useActiveAgentId(): string | undefined {
  return useRouterState({ select: (s) => /^\/agents\/([^/]+)/.exec(s.location.pathname)?.[1] });
}

function Rail() {
  const agents = useAgents();
  const sorted = agents.data ? sortAgents(agents.data) : [];
  const activeAgentId = useActiveAgentId();
  return (
    <>
      <div className="flex h-14 items-center justify-center">
        <Link to="/" aria-label="Home">
          <Mark />
        </Link>
      </div>
      <span className="mx-auto mb-2 h-px w-8 bg-line" />
      <ul className="vc-noscroll flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto px-2 pb-2">
        {sorted.map((a) => {
          const s = statusLine(a);
          const active = a.id === activeAgentId;
          return (
            <li key={a.id} className="relative flex items-center">
              <span
                aria-hidden
                className={cn(
                  "-left-2 absolute h-6 w-[3px] rounded-r-full bg-foreground transition-opacity",
                  active ? "opacity-100" : "opacity-0",
                )}
              />
              <Tooltip>
                <TooltipTrigger asChild>
                  <Link
                    to="/agents/$agentId"
                    params={{ agentId: a.id }}
                    data-testid="sidebar-agent"
                    className={cn(
                      "relative flex size-12 items-center justify-center rounded-[14px] transition-colors hover:bg-muted/70 focus-visible:bg-muted/70 focus-visible:outline-none",
                      active && "bg-muted hover:bg-muted",
                    )}
                  >
                    <AgentAvatar
                      avatar={a.avatar}
                      presence={a.presence}
                      size={36}
                      surface={active ? "var(--muted)" : "var(--panel)"}
                    />
                    <span className="sr-only">{a.name}</span>
                    {a.unread > 0 && (
                      <Badge
                        data-testid="unread"
                        className="-top-0.5 -right-0.5 absolute h-[18px] min-w-[18px] px-1.5 text-2xs ring-2 ring-panel"
                      >
                        {a.unread}
                      </Badge>
                    )}
                  </Link>
                </TooltipTrigger>
                <TooltipContent side="right" className="flex items-center gap-2 px-3 py-2 text-[12.5px]">
                  <span className="font-semibold">{a.name}</span>
                  <span className={cn("max-w-[220px] truncate", s.className)}>{s.text}</span>
                  {a.unread > 0 && (
                    <Badge className="h-[18px] min-w-[18px] px-1.5 text-2xs">{a.unread}</Badge>
                  )}
                </TooltipContent>
              </Tooltip>
            </li>
          );
        })}
        <li className="mt-1">
          <RailIcon label="New agent" to="/agents/new" dashed>
            <Plus className="size-4" />
          </RailIcon>
        </li>
      </ul>
      <GlobalCallIndicator exceptAgentId={activeAgentId} variant="rail" />
      <ul className="flex flex-col items-center gap-1 px-2 pt-2">
        <li>
          <RailIcon label="Search · ⌘K" onClick={() => setPaletteOpen(true)}>
            <Search className="size-[18px]" />
          </RailIcon>
        </li>
        {BOTTOM.map((b) => (
          <li key={b.to}>
            <RailIcon label={b.label} to={b.to}>
              <b.icon className="size-[18px]" />
            </RailIcon>
          </li>
        ))}
      </ul>
      <span className="mx-auto my-2.5 h-px w-8 bg-line" />
      <div className="flex flex-col items-center gap-2 pb-3">
        <DeviceChip compact />
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="Expand sidebar"
              onClick={toggleSidebar}
              className="flex size-8 items-center justify-center rounded-[8px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <PanelLeftOpen className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">
            Expand sidebar <kbd className="ml-1">⌘\</kbd>
          </TooltipContent>
        </Tooltip>
      </div>
    </>
  );
}

function RailIcon({
  label,
  to,
  onClick,
  dashed,
  children,
}: {
  label: string;
  to?: "/agents/new" | "/memories" | "/settings/mcp" | "/settings";
  onClick?: () => void;
  dashed?: boolean;
  children: ReactNode;
}) {
  const className = cn(
    "flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:outline-none",
    dashed && "rounded-full border border-line-strong border-dashed hover:border-solid",
  );
  const activeProps = { className: cn(className, "bg-muted text-foreground") };
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {to ? (
          <Link to={to} aria-label={label} className={className} activeProps={activeProps}>
            {children}
          </Link>
        ) : (
          <button type="button" aria-label={label} className={className} onClick={onClick}>
            {children}
          </button>
        )}
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

function Expanded() {
  const agents = useAgents();
  const sorted = agents.data ? sortAgents(agents.data) : [];
  const activeAgentId = useActiveAgentId();
  return (
    <>
      <div className="flex h-14 items-center gap-2.5 px-4">
        <Link to="/" className="flex items-center gap-2.5" aria-label="Home">
          <Mark />
          <span className="font-semibold text-sm tracking-tight">Vibe Center</span>
        </Link>
        <span className="flex-1" />
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="Collapse sidebar"
              onClick={toggleSidebar}
              className="flex size-8 items-center justify-center rounded-[8px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <PanelLeftClose className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">
            Collapse sidebar <kbd className="ml-1">⌘\</kbd>
          </TooltipContent>
        </Tooltip>
      </div>
      <div className="px-3">
        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          className="flex h-9 w-full items-center gap-2 rounded-lg border border-line bg-background px-3 text-muted-foreground text-sm transition-colors hover:border-line-strong hover:text-foreground"
        >
          <Search className="size-4" />
          <span className="flex-1 text-left">Search</span>
          <kbd>⌘K</kbd>
        </button>
      </div>
      <div className="mt-4 flex items-center justify-between px-5 pb-1">
        <span className="vc-label">Agents</span>
        <Link
          to="/agents/new"
          aria-label="New agent"
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Plus className="size-3.5" />
        </Link>
      </div>
      <ul className="vc-noscroll flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-2">
        {sorted.map((a) => {
          const s = statusLine(a);
          const active = a.id === activeAgentId;
          return (
            <li key={a.id}>
              <Link
                to="/agents/$agentId"
                params={{ agentId: a.id }}
                data-testid="sidebar-agent"
                className={cn(
                  "flex items-center gap-3 rounded-xl px-2.5 py-2 transition-colors hover:bg-muted/70",
                  active && "bg-muted hover:bg-muted",
                )}
              >
                <AgentAvatar
                  avatar={a.avatar}
                  presence={a.presence}
                  size={34}
                  surface={active ? "var(--muted)" : "var(--panel)"}
                />
                <span className="min-w-0 flex-1 leading-tight">
                  <span className="flex items-baseline justify-between gap-2">
                    <span
                      className={cn("truncate text-[13.5px]", a.unread ? "font-semibold" : "font-medium")}
                    >
                      {a.name}
                    </span>
                  </span>
                  <span className="mt-0.5 flex items-center gap-2">
                    <span className={cn("truncate text-[12.5px]", s.className)}>{s.text}</span>
                    {a.unread > 0 && (
                      <Badge data-testid="unread" className="ml-auto h-[18px] min-w-[18px] px-1.5 text-2xs">
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
            className="flex items-center gap-3 rounded-xl px-2.5 py-2 text-muted-foreground text-sm transition-colors hover:bg-muted/70 hover:text-foreground"
          >
            <span className="flex size-[34px] items-center justify-center rounded-full border border-line-strong border-dashed">
              <Plus className="size-4" />
            </span>
            New agent
          </Link>
        </li>
      </ul>
      <GlobalCallIndicator exceptAgentId={activeAgentId} variant="list" />
      <ul className="flex flex-col gap-0.5 px-2 pt-2 pb-2 text-sm">
        {BOTTOM.map((b) => (
          <li key={b.to}>
            <Link
              to={b.to}
              className="flex h-9 items-center gap-3 rounded-lg px-2.5 text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
              activeProps={{ className: "bg-muted text-foreground hover:bg-muted" }}
            >
              <b.icon className="size-4" /> {b.label}
            </Link>
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-3 border-line border-t px-4 py-3">
        <DeviceChip />
      </div>
    </>
  );
}

/** The signed-in device: a monogram, plus name and connection state when there's room. */
function DeviceChip({ compact = false }: { compact?: boolean }) {
  const me = useMe();
  const connection = useConnectionState();
  const live = connection === "open";
  const name = me.data?.name ?? "This device";
  const chip = (
    <span className="relative inline-flex">
      <UserAvatar size={28} />
      <span
        aria-hidden
        className={cn(
          "-right-px -bottom-px absolute size-2.5 rounded-full ring-2 ring-panel",
          live ? "bg-presence-working" : "animate-vc-pulse bg-presence-waiting",
        )}
      />
    </span>
  );
  if (compact) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Link to="/settings/devices" aria-label="This device" className="rounded-full">
            {chip}
          </Link>
        </TooltipTrigger>
        <TooltipContent side="right">
          <span className="font-medium">{name}</span>
          <span className="text-muted-foreground"> · {live ? "Live" : "Reconnecting…"}</span>
        </TooltipContent>
      </Tooltip>
    );
  }
  return (
    <Link to="/settings/devices" className="flex min-w-0 flex-1 items-center gap-3">
      {chip}
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block truncate font-medium text-sm">{name}</span>
        <span className="block truncate text-muted-foreground text-xs">
          {live ? "This device · live" : "Reconnecting…"}
        </span>
      </span>
    </Link>
  );
}

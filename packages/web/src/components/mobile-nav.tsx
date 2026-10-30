import { Link, useRouterState } from "@tanstack/react-router";
import { Menu } from "lucide-react";
import { useState } from "react";
import { useAgent } from "@/lib/queries";
import { AgentAvatar, presenceLabel } from "./agent-avatar";
import { SidebarContent } from "./sidebar";
import { Button } from "./ui/button";
import { Sheet, SheetContent, SheetTitle } from "./ui/sheet";
import { GlobalCallIndicator } from "./voice/call-indicator";

/** Below the `sm` breakpoint the persistent Sidebar is hidden; this top bar + drawer replaces it. */
export function MobileNav() {
  const [open, setOpen] = useState(false);
  const agentId = useRouterState({ select: (s) => /^\/agents\/([^/]+)/.exec(s.location.pathname)?.[1] });
  const agent = useAgent(agentId ?? "");
  return (
    <div className="sm:hidden">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b bg-sidebar px-2 text-sidebar-foreground">
        <Button variant="ghost" size="icon" aria-label="Open agent list" onClick={() => setOpen(true)}>
          <Menu className="size-5" />
        </Button>
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent side="left" className="w-72 gap-0 bg-sidebar p-0 text-sidebar-foreground">
            <SheetTitle className="sr-only">Agents</SheetTitle>
            <SidebarContent onNavigate={() => setOpen(false)} />
          </SheetContent>
        </Sheet>
        {agent ? (
          <Link
            to="/agents/$agentId"
            params={{ agentId: agent.id }}
            className="flex min-w-0 flex-1 items-center gap-2"
          >
            <AgentAvatar avatar={agent.avatar} presence={agent.presence} size="sm" />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium text-sm leading-tight">{agent.name}</span>
              <span
                data-testid="mobile-presence"
                className="block truncate text-muted-foreground text-xs leading-tight"
              >
                {presenceLabel[agent.presence]}
                {agent.presenceDetail ? ` · ${agent.presenceDetail}` : ""}
              </span>
            </span>
          </Link>
        ) : (
          <span className="flex-1 truncate font-semibold text-sm">Vibe Center</span>
        )}
      </header>
      <GlobalCallIndicator exceptAgentId={agent?.id} className="bg-sidebar text-sidebar-foreground" />
    </div>
  );
}

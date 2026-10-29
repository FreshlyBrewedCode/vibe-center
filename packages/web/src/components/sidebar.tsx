import { Link } from "@tanstack/react-router";
import { Plus, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConnectionState } from "@/lib/events";
import { useAgents } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { AgentAvatar } from "./agent-avatar";

export function Sidebar() {
  const agents = useAgents();
  const connection = useConnectionState();
  return (
    <nav className="flex w-64 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground max-md:w-20">
      <div className="flex h-12 items-center justify-between px-3">
        <Link to="/" className="font-semibold max-md:hidden">
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
      <div className="flex items-center justify-between px-3 pt-2 pb-1 text-muted-foreground text-xs">
        <span className="max-md:hidden">Agents</span>
        <Button asChild variant="ghost" size="icon" className="size-6" aria-label="New agent">
          <Link to="/agents/new">
            <Plus className="size-4" />
          </Link>
        </Button>
      </div>
      <ul className="flex-1 space-y-0.5 overflow-y-auto px-2">
        {agents.data?.map((a) => (
          <li key={a.id}>
            <Link
              to="/agents/$agentId"
              params={{ agentId: a.id }}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-sidebar-accent"
              activeProps={{ className: "bg-sidebar-accent font-medium" }}
              data-testid="sidebar-agent"
            >
              <AgentAvatar avatar={a.avatar} presence={a.presence} size="sm" />
              <span className={cn("flex-1 truncate max-md:hidden", a.unread > 0 && "font-semibold")}>
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
      <div className="border-t p-2">
        <Link
          to="/settings"
          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-sidebar-accent"
          activeProps={{ className: "bg-sidebar-accent" }}
        >
          <Settings className="size-4" />
          <span className="max-md:hidden">Settings</span>
        </Link>
      </div>
    </nav>
  );
}

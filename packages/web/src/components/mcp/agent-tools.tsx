import { Link } from "@tanstack/react-router";
import type { AgentToolGroup } from "@vibe-center/shared";
import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { useAgentTools, useSetAgentTool } from "@/lib/queries";
import { McpStatusBadge } from "./status-badge";

/**
 * The agent's tools, grouped by MCP server, built-ins first. Toggles save at once and reach a
 * running session live (the gateway sends tools/list_changed); calls to disabled tools are refused.
 */
export function AgentTools({ agentId }: { agentId: string }) {
  const groups = useAgentTools(agentId);
  const set = useSetAgentTool(agentId);
  const toggle = (serverId: string, enabled: boolean, tool?: string) =>
    set.mutate({ serverId, tool, enabled }, { onError: (e) => toast.error(e.message) });
  return (
    <section className="mx-auto w-full max-w-2xl space-y-3 px-4 pb-6 sm:px-8" data-testid="agent-tools">
      <div className="border-line border-b pb-2">
        <h2 className="font-semibold text-sm">Tools</h2>
        <p className="mt-0.5 text-muted-foreground text-xs">
          Changes apply right away, also to a running session. New tools a server adds later follow its
          switch.{" "}
          <Link
            to="/settings/mcp"
            className="underline decoration-line-strong underline-offset-2 hover:decoration-foreground"
          >
            Manage MCP servers
          </Link>
        </p>
      </div>
      <ul className="divide-y divide-line rounded-xl border border-line bg-card">
        {groups.data?.map((g) => (
          <Group key={g.serverId} group={g} pending={set.isPending} onToggle={toggle} />
        ))}
      </ul>
    </section>
  );
}

function Group({
  group: g,
  pending,
  onToggle,
}: {
  group: AgentToolGroup;
  pending: boolean;
  onToggle: (serverId: string, enabled: boolean, tool?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const on = g.tools.filter((t) => t.enabled).length;
  const label = g.builtin ? "Built-in" : g.serverName;
  return (
    <li data-testid={`tool-group-${g.serverName}`} className="p-3.5">
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => setOpen(!open)}
        >
          <ChevronRight className={`size-3.5 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
          <span className="font-medium text-sm">{label}</span>
          {!g.builtin && <McpStatusBadge status={g.status} />}
          <span className="flex-1 truncate text-muted-foreground text-xs">
            {g.serverEnabled ? `${on} of ${g.tools.length} on` : "server disabled"}
          </span>
        </button>
        <Switch
          aria-label={`All ${label} tools`}
          checked={g.enabled}
          disabled={pending}
          onCheckedChange={(v) => onToggle(g.serverId, v)}
        />
      </div>
      {open && (
        <ul className="mt-2 space-y-1.5 pl-6">
          {g.tools.length === 0 && (
            <li className="text-muted-foreground text-xs">No tools discovered yet (refresh the server).</li>
          )}
          {g.tools.map((t) => (
            <li key={t.name} className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <code className="font-mono text-xs">{t.exposedName}</code>
                {t.description && (
                  <p className="truncate text-muted-foreground text-xs" title={t.description}>
                    {t.description.split("\n")[0]}
                  </p>
                )}
              </div>
              <Switch
                aria-label={t.exposedName}
                checked={t.enabled}
                disabled={pending}
                onCheckedChange={(v) => onToggle(g.serverId, v, t.name)}
              />
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

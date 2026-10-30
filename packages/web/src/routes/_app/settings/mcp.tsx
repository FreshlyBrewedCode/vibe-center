import { createFileRoute } from "@tanstack/react-router";
import type { McpServerView } from "@vibe-center/shared";
import { ChevronRight, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { McpOAuthStatus } from "@/components/mcp/oauth";
import { McpServerDialog } from "@/components/mcp/server-form";
import { McpStatusBadge } from "@/components/mcp/status-badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useDeleteMcpServer, useMcpServers, useRefreshMcpServer, useSaveMcpServer } from "@/lib/queries";
import { Card, Section } from "../settings";

export const Route = createFileRoute("/_app/settings/mcp")({ component: McpServers });

function McpServers() {
  const servers = useMcpServers();
  const [adding, setAdding] = useState(false);
  return (
    <Section
      title="MCP servers"
      description="Every agent reaches these through the app's MCP gateway. Choose which tools each agent gets in its settings (Edit agent → Tools). Built-in tools are on for every agent by default; tools from servers you add here are off until you enable them for an agent. An HTTP server that asks for OAuth shows Sign in; that one sign-in is shared by every agent."
    >
      <Card>
        <ul className="divide-y divide-line">
          {servers.data?.map((s) => (
            <ServerRow key={s.id} server={s} />
          ))}
        </ul>
      </Card>
      <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
        <Plus className="size-4" /> Add MCP server
      </Button>
      {adding && <McpServerDialog open onOpenChange={setAdding} />}
    </Section>
  );
}

function ServerRow({ server: s }: { server: McpServerView }) {
  const refresh = useRefreshMcpServer();
  const del = useDeleteMcpServer();
  const toggle = useSaveMcpServer(s.id);
  const [editing, setEditing] = useState(false);
  const endpoint = s.builtin
    ? "Memory, conversation search and agents, provided by the app"
    : s.transport === "stdio"
      ? [s.command, ...s.args].join(" ")
      : s.url;
  return (
    <li data-testid={`mcp-server-${s.name}`} className="space-y-1.5 p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-sm">{s.builtin ? "Built-in" : s.name}</span>
        <Badge variant="outline">{s.builtin ? "built-in" : s.transport}</Badge>
        <McpStatusBadge status={s.status} />
        <span className="flex-1" />
        {!s.builtin && (
          <>
            <Switch
              aria-label={`Enable ${s.name}`}
              checked={s.enabled}
              disabled={toggle.isPending}
              onCheckedChange={(enabled) =>
                toggle.mutate({ enabled }, { onError: (e) => toast.error(e.message) })
              }
            />
            <Button
              size="sm"
              variant="quiet"
              disabled={refresh.isPending || !s.enabled}
              onClick={() =>
                refresh.mutate(s.id, {
                  onSuccess: (v) =>
                    v.status.state === "error"
                      ? toast.error(`${s.name}: ${v.status.message}`)
                      : toast.success(`${s.name}: ${v.tools.length} tools`),
                  onError: (e) => toast.error(e.message),
                })
              }
            >
              <RefreshCw className={refresh.isPending ? "size-3.5 animate-spin" : "size-3.5"} /> Refresh
            </Button>
            <Button
              size="icon-sm"
              variant="quiet"
              aria-label={`Edit ${s.name}`}
              onClick={() => setEditing(true)}
            >
              <Pencil className="size-3.5" />
            </Button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="icon-sm" variant="quiet" aria-label={`Remove ${s.name}`}>
                  <Trash2 className="size-3.5" />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Remove {s.name}?</AlertDialogTitle>
                  <AlertDialogDescription>Agents lose its tools.</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => del.mutate(s.id, { onError: (e) => toast.error(e.message) })}
                  >
                    Remove
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </>
        )}
      </div>
      <code className="block truncate font-mono text-muted-foreground text-xs">{endpoint}</code>
      {Object.keys(s.env).length + Object.keys(s.headers).length > 0 && (
        <p className="text-muted-foreground text-xs">
          Secrets: {[...Object.keys(s.env), ...Object.keys(s.headers)].join(", ")}
        </p>
      )}
      <McpOAuthStatus server={s} />
      {s.status.state === "error" && s.status.message && (
        <pre className="vc-scroll max-h-32 overflow-auto whitespace-pre-wrap rounded-[8px] border border-destructive/30 bg-destructive/8 px-3 py-2 font-mono text-destructive text-xs">
          {s.status.message}
        </pre>
      )}
      <details className="group text-sm">
        <summary className="flex cursor-pointer list-none items-center gap-1 text-muted-foreground text-xs [&::-webkit-details-marker]:hidden">
          <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />
          {s.tools.length} tools
          {s.status.serverInfo &&
            !s.builtin &&
            ` · ${s.status.serverInfo.name} ${s.status.serverInfo.version}`}
        </summary>
        <ul className="mt-1.5 space-y-1 pl-5">
          {s.tools.map((t) => (
            <li key={t.name} className="text-xs">
              <code className="font-medium font-mono">{t.name}</code>
              {t.description && (
                <span className="text-muted-foreground"> · {t.description.split("\n")[0]}</span>
              )}
            </li>
          ))}
        </ul>
      </details>
      {editing && <McpServerDialog server={s} open onOpenChange={setEditing} />}
    </li>
  );
}

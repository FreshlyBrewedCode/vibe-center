import type { AgentView, Message } from "@vibe-center/shared";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  CornerDownRight,
  FileSearch,
  FolderOpen,
  Globe,
  Loader2,
  Pencil,
  ShieldQuestion,
  Terminal,
  Trash2,
  User,
  Wrench,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useAgent, useAnswerPermission } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { AgentAvatar } from "../agent-avatar";
import { Markdown } from "../markdown";
import { GatewayCallDetails, gatewayTitle } from "../mcp/gateway-call";
import { FixInSettingsLink } from "../settings-hint";

/** One row in the DM. `showHeader` is false for follow-ups from the same sender. */
export function MessageItem({
  message: m,
  agent,
  showHeader,
}: {
  message: Message;
  agent: AgentView;
  showHeader: boolean;
}) {
  switch (m.kind) {
    case "session":
      return <SessionDivider message={m} />;
    case "text":
    case "voice_transcript":
      return (
        <Row message={m} agent={agent} showHeader={showHeader}>
          {m.role === "user" ? (
            <p className="whitespace-pre-wrap text-sm">{m.text}</p>
          ) : (
            <Markdown text={m.text} />
          )}
          {m.status === "streaming" && (
            <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-foreground/60" />
          )}
          {m.status === "cancelled" && <p className="text-muted-foreground text-xs italic">Stopped</p>}
          {m.status !== "cancelled" && m.data?.interrupted && (
            <p className="text-muted-foreground text-xs italic">
              Interrupted — you may not have heard all of this
            </p>
          )}
        </Row>
      );
    case "thought":
      return (
        <Row message={m} agent={agent} showHeader={showHeader}>
          <Collapsible label="Thinking" className="text-muted-foreground">
            <p className="whitespace-pre-wrap text-xs">{m.text}</p>
          </Collapsible>
        </Row>
      );
    case "plan":
      return (
        <Row message={m} agent={agent} showHeader={showHeader}>
          <Collapsible label="Plan">
            <ul className="space-y-0.5 text-xs">
              {m.data.entries.map((e) => (
                <li
                  key={e.content}
                  className={cn(e.status === "completed" && "text-muted-foreground line-through")}
                >
                  {e.content}
                </li>
              ))}
            </ul>
          </Collapsible>
        </Row>
      );
    case "tool_call":
      return (
        <Row message={m} agent={agent} showHeader={showHeader}>
          <ToolCard message={m} />
        </Row>
      );
    case "permission":
      return (
        <Row message={m} agent={agent} showHeader={showHeader}>
          <PermissionCard message={m} />
        </Row>
      );
    case "error":
      return (
        <Row message={m} agent={agent} showHeader={showHeader}>
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
            <span className="flex-1 whitespace-pre-wrap">{m.text}</span>
            {m.data?.hint && <FixInSettingsLink hint={m.data.hint} />}
          </div>
        </Row>
      );
  }
}

function Row({
  message: m,
  agent,
  showHeader,
  children,
}: {
  message: Message;
  agent: AgentView;
  showHeader: boolean;
  children: React.ReactNode;
}) {
  const isUser = m.role === "user";
  // Prompts from another agent (send_message_to_agent) and replies delivered back from it.
  const meta = isUser && (m.kind === "text" || m.kind === "voice_transcript") ? m.data : null;
  const relay = meta?.fromAgentId && (meta.source === "agent" || meta.source === "event") ? meta : null;
  const fromAgent = useAgent(relay?.fromAgentId ?? "");
  return (
    <div data-testid={`message-${m.role}`} className={cn("flex gap-3 px-4", showHeader ? "pt-3" : "pt-0.5")}>
      <div className="w-8 shrink-0">
        {showHeader &&
          (fromAgent ? (
            <AgentAvatar avatar={fromAgent.avatar} />
          ) : isUser ? (
            <span className="inline-flex size-8 items-center justify-center rounded-lg bg-muted">
              <User className="size-4 text-muted-foreground" />
            </span>
          ) : (
            <AgentAvatar avatar={agent.avatar} />
          ))}
      </div>
      <div className="min-w-0 flex-1">
        {showHeader && (
          <div className="flex items-baseline gap-2">
            <span className="font-semibold text-sm">
              {relay ? (fromAgent?.name ?? "Another agent") : isUser ? "You" : agent.name}
            </span>
            {relay && (
              <span data-testid="relay" className="flex items-center gap-1 text-muted-foreground text-xs">
                <CornerDownRight className="size-3" />
                {relay.source === "agent" ? `message to ${agent.name}` : `reply to ${agent.name}`}
              </span>
            )}
            <time className="text-muted-foreground text-xs">
              {new Date(m.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </time>
            {m.kind === "voice_transcript" && <span className="text-muted-foreground text-xs">· voice</span>}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

function Collapsible({
  label,
  icon,
  className,
  children,
}: {
  label: React.ReactNode;
  icon?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <details className={cn("group rounded-md border bg-card text-sm", className)}>
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-1.5">
        <ChevronRight className="size-3.5 shrink-0 transition-transform group-open:rotate-90" />
        {icon}
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </summary>
      <div className="border-t px-3 py-2">{children}</div>
    </details>
  );
}

// Maps ACP tool kinds to an icon. 2a's richer tool-call cards can extend this; the card stays a
// `Collapsible` with a label/icon/content, so new tool kinds only need a new icon mapping.
const TOOL_ICONS: Record<string, typeof Wrench> = {
  read: FileSearch,
  edit: Pencil,
  delete: Trash2,
  move: FolderOpen,
  search: FileSearch,
  execute: Terminal,
  fetch: Globe,
};

function ToolCard({ message: m }: { message: Extract<Message, { kind: "tool_call" }> }) {
  const d = m.data;
  const Icon = (d.toolKind && TOOL_ICONS[d.toolKind]) || Wrench;
  const statusIcon =
    d.toolStatus === "completed" ? (
      <Check className="size-3.5 text-presence-working" />
    ) : d.toolStatus === "failed" ? (
      <X className="size-3.5 text-destructive" />
    ) : (
      <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
    );
  return (
    <div data-testid="tool-call" data-status={d.toolStatus}>
      <Collapsible
        label={d.gateway ? gatewayTitle(d.gateway) : d.title}
        icon={
          <>
            <Icon className="size-3.5 shrink-0 text-muted-foreground" />
            {statusIcon}
          </>
        }
      >
        {d.gateway ? (
          <>
            <GatewayCallDetails call={d.gateway} />
            {d.toolStatus === "failed" && (
              <div className="flex items-center gap-2 pt-2">
                <span className="flex-1 text-muted-foreground text-xs">
                  The "{d.gateway.server}" MCP server may be misconfigured or down.
                </span>
                <FixInSettingsLink hint="settings:mcp" />
              </div>
            )}
          </>
        ) : (
          <>
            {d.locations.length > 0 && (
              <div className="flex flex-wrap gap-1 pb-2">
                {d.locations.map((loc) => (
                  <code
                    key={`${loc.path}:${loc.line ?? ""}`}
                    className="rounded bg-muted px-1.5 py-0.5 text-xs"
                  >
                    {loc.path}
                    {loc.line != null ? `:${loc.line}` : ""}
                  </code>
                ))}
              </div>
            )}
            {d.rawInput !== undefined && <Pre label="Input" value={d.rawInput} />}
            {d.content.length > 0 && <Pre label="Output" value={d.content.join("\n\n")} />}
            {d.content.length === 0 && d.rawOutput !== undefined && (
              <Pre label="Output" value={d.rawOutput} />
            )}
          </>
        )}
      </Collapsible>
    </div>
  );
}

function Pre({ label, value }: { label: string; value: unknown }) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return (
    <div className="space-y-1 pb-2 last:pb-0">
      <div className="text-muted-foreground text-xs">{label}</div>
      <pre className="max-h-64 overflow-auto rounded bg-muted p-2 text-xs">{text}</pre>
    </div>
  );
}

function PermissionCard({ message: m }: { message: Extract<Message, { kind: "permission" }> }) {
  const d = m.data;
  const chosen =
    d.outcome && d.outcome !== "cancelled"
      ? d.options.find((o) => o.optionId === (d.outcome as { optionId: string }).optionId)
      : null;
  return (
    <div
      data-testid="permission"
      className="space-y-2 rounded-md border border-presence-waiting/50 bg-presence-waiting/10 px-3 py-2"
    >
      <div className="flex items-center gap-2 text-sm">
        <ShieldQuestion className="size-4 shrink-0" />
        <span className="font-medium">{d.title}</span>
      </div>
      {d.rawInput !== undefined && <Pre label="Request" value={d.rawInput} />}
      {m.status === "pending" ? (
        <PermissionButtons message={m} />
      ) : (
        <p className="text-muted-foreground text-xs">
          {chosen ? `Answered: ${chosen.name}` : "No longer needed (the turn ended)"}
        </p>
      )}
    </div>
  );
}

/** The answer buttons of a pending permission request (in the DM and in the call bar). */
export function PermissionButtons({ message: m }: { message: Extract<Message, { kind: "permission" }> }) {
  const answer = useAnswerPermission();
  return (
    <div className="flex flex-wrap gap-2">
      {m.data.options.map((o) => (
        <Button
          key={o.optionId}
          size="sm"
          variant={o.kind.startsWith("allow") ? "default" : "outline"}
          disabled={answer.isPending}
          onClick={() =>
            answer.mutate(
              { messageId: m.id, optionId: o.optionId },
              { onError: (e) => toast.error(e.message) },
            )
          }
        >
          {o.name}
        </Button>
      ))}
    </div>
  );
}

function SessionDivider({ message: m }: { message: Message }) {
  return (
    <div
      data-testid="session-divider"
      className="flex items-center gap-3 px-4 py-3 text-muted-foreground text-xs"
    >
      <div className="h-px flex-1 bg-border" />
      <span title={m.text}>
        {m.data && "reason" in m.data && m.data.reason === "resume_failed"
          ? "New session (previous could not be resumed)"
          : "New session"}{" "}
        · {new Date(m.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}
      </span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

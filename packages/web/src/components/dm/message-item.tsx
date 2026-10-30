import type { AgentView, Message } from "@vibe-center/shared";
import {
  AlertTriangle,
  AudioLines,
  Bell,
  Brain,
  Check,
  ChevronDown,
  CornerDownRight,
  FilePen,
  FileSearch,
  FolderOpen,
  Globe,
  Hourglass,
  ListChecks,
  Loader2,
  Plug,
  Search,
  ShieldAlert,
  Terminal,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useAgent, useAnswerPermission, useMcpServers } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { AgentAvatar, UserAvatar } from "../agent-avatar";
import { Markdown } from "../markdown";
import { GatewayCallDetails, gatewayTitle } from "../mcp/gateway-call";
import { FixInSettingsLink } from "../settings-hint";
import { Divider } from "./message-list";

/** Where a tool call sits in a run of consecutive tool calls (they fold into one activity card). */
export type Fold = "single" | "first" | "middle" | "last";

/** Content indent: the 28px avatar plus its 10px gap, so text lines up under the name. */
const INDENT = "pl-[38px]";

/** One row in the DM. `showHeader` is false for follow-ups from the same sender. */
export function MessageItem({
  message: m,
  agent,
  showHeader,
  fold = "single",
}: {
  message: Message;
  agent: AgentView;
  showHeader: boolean;
  fold?: Fold;
}) {
  switch (m.kind) {
    case "session":
      return <SessionDivider message={m} />;
    case "text":
    case "voice_transcript":
      return (
        <Row message={m} agent={agent} showHeader={showHeader}>
          {m.role === "user" ? (
            <p className="max-w-[72ch] whitespace-pre-wrap leading-[1.55]">
              {m.text}
              {m.status === "streaming" && <Caret />}
            </p>
          ) : (
            <Markdown text={m.text} streaming={m.status === "streaming"} />
          )}
          {m.status === "cancelled" && <Marker>Stopped</Marker>}
          {m.status !== "cancelled" && m.data?.interrupted && (
            <Marker icon={<AudioLines className="size-3" />}>
              Interrupted: you may not have heard all of this
            </Marker>
          )}
        </Row>
      );
    case "thought":
      return (
        <Row message={m} agent={agent} showHeader={showHeader}>
          <ActivityCard>
            <details className="group">
              <ActivitySummary icon={<Brain className="size-3.5 text-muted-foreground" />} verb="Thinking">
                <span className="truncate text-muted-foreground">{firstLine(m.text)}</span>
              </ActivitySummary>
              <div className="border-line border-t px-3.5 py-2.5 text-muted-foreground text-sm">
                <p className="whitespace-pre-wrap">{m.text}</p>
              </div>
            </details>
          </ActivityCard>
        </Row>
      );
    case "plan": {
      const done = m.data.entries.filter((e) => e.status === "completed").length;
      return (
        <Row message={m} agent={agent} showHeader={showHeader}>
          <ActivityCard>
            <details className="group">
              <ActivitySummary icon={<ListChecks className="size-3.5 text-muted-foreground" />} verb="Plan">
                <span className="text-muted-foreground">
                  {done} of {m.data.entries.length} done
                </span>
              </ActivitySummary>
              <ul className="space-y-1.5 border-line border-t px-3.5 py-2.5 text-sm">
                {m.data.entries.map((e) => (
                  <li key={e.content} className="flex items-start gap-2">
                    <span
                      className={cn(
                        "mt-[3px] flex size-3.5 shrink-0 items-center justify-center rounded-full border",
                        e.status === "completed"
                          ? "border-presence-working bg-presence-working text-primary-foreground"
                          : e.status === "in_progress"
                            ? "border-presence-thinking"
                            : "border-line-strong",
                      )}
                    >
                      {e.status === "completed" && <Check className="size-2.5" strokeWidth={3} />}
                    </span>
                    <span className={cn(e.status === "completed" && "text-muted-foreground line-through")}>
                      {e.content}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          </ActivityCard>
        </Row>
      );
    }
    case "tool_call":
      return (
        <Row message={m} agent={agent} showHeader={showHeader} tight={fold === "middle" || fold === "last"}>
          <ToolCard message={m} fold={fold} />
        </Row>
      );
    case "permission":
      return (
        <Row message={m} agent={agent} showHeader={showHeader}>
          <PermissionCard message={m} agentName={agent.name} />
        </Row>
      );
    case "error":
      return (
        <Row message={m} agent={agent} showHeader={showHeader}>
          <div className="flex max-w-[720px] flex-wrap items-start gap-2.5 rounded-xl border border-destructive/40 bg-destructive/8 px-3.5 py-2.5 text-sm">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
            <span className="min-w-0 flex-1 whitespace-pre-wrap">{m.text}</span>
            {m.data?.hint && <FixInSettingsLink hint={m.data.hint} />}
          </div>
        </Row>
      );
  }
}

function firstLine(text: string): string {
  return text.split("\n").find((l) => l.trim()) ?? "";
}

function Caret() {
  return (
    <span
      aria-hidden
      className="ml-0.5 inline-block h-[1em] w-[2px] translate-y-[2px] animate-vc-caret bg-primary align-baseline"
    />
  );
}

function Marker({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <p className="mt-1 flex items-center gap-1.5 text-muted-foreground text-xs italic">
      {icon}
      {children}
    </p>
  );
}

/**
 * A turn: an optional name line (avatar, name, time, "Spoken" / relay chips) and the content
 * indented under it. The thread is a centred 960px column with the same indent on every row,
 * so long and short replies read the same (no bubbles).
 */
function Row({
  message: m,
  agent,
  showHeader,
  tight = false,
  children,
}: {
  message: Message;
  agent: AgentView;
  showHeader: boolean;
  /** No gap above: the content continues the previous row's card. */
  tight?: boolean;
  children: ReactNode;
}) {
  const isUser = m.role === "user";
  // Prompts from another agent (send_message_to_agent) and replies delivered back from it.
  const meta = isUser && (m.kind === "text" || m.kind === "voice_transcript") ? m.data : null;
  const relay = meta?.fromAgentId && (meta.source === "agent" || meta.source === "event") ? meta : null;
  // A fired background wait (timer, background call, webhook) the app prompted the agent with.
  const fired = !relay && meta?.source === "event" && meta.watch ? meta.watch : null;
  const fromAgent = useAgent(relay?.fromAgentId ?? "");
  const relayColor = fromAgent?.avatar.color;
  const name = relay ? (fromAgent?.name ?? "Another agent") : fired ? "Event" : isUser ? "You" : agent.name;
  return (
    <div
      data-testid={`message-${m.role}`}
      className={cn("px-4 sm:px-10", showHeader ? "pt-5" : tight ? "pt-0" : "pt-1.5")}
    >
      <div className="mx-auto max-w-[960px]">
        {showHeader && (
          <div className="flex items-center gap-2.5">
            {fromAgent ? (
              <AgentAvatar avatar={fromAgent.avatar} size={28} />
            ) : fired ? (
              <span className="grid size-7 shrink-0 place-items-center rounded-full border border-line text-muted-foreground">
                <Bell className="size-3.5" />
              </span>
            ) : isUser ? (
              <UserAvatar size={28} />
            ) : (
              <AgentAvatar avatar={agent.avatar} size={28} />
            )}
            <span
              className="truncate font-semibold text-sm"
              style={relayColor ? { color: relayColor } : undefined}
            >
              {name}
            </span>
            <time className="shrink-0 text-muted-foreground text-xs tabular-nums">
              {new Date(m.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </time>
            {m.kind === "voice_transcript" && (
              <span className="inline-flex shrink-0 items-center gap-1 text-2xs text-muted-foreground">
                <AudioLines className="size-3" /> Spoken
              </span>
            )}
            {fired && (
              <span
                data-testid="fired-watch"
                className="inline-flex min-w-0 items-center gap-1 truncate rounded-full border border-line px-2 py-px text-2xs text-muted-foreground"
              >
                <Hourglass className="size-3 shrink-0" />
                <span className="truncate">{fired.label}</span>
              </span>
            )}
            {relay && (
              <span
                data-testid="relay"
                className="inline-flex min-w-0 items-center gap-1 truncate rounded-full border border-line px-2 py-px text-2xs text-muted-foreground"
              >
                <CornerDownRight className="size-3 shrink-0" />
                {relay.source === "agent" ? `message to ${agent.name}` : `reply to ${agent.name}`}
              </span>
            )}
          </div>
        )}
        <div
          className={cn(showHeader && "mt-1", INDENT)}
          style={
            relay
              ? {
                  borderLeft: `2px solid ${relayColor ?? "var(--line-strong)"}`,
                  marginLeft: 38,
                  paddingLeft: 12,
                }
              : undefined
          }
        >
          {children}
        </div>
      </div>
    </div>
  );
}

/** The card surface for thinking, plans and tool calls: hairline, 12px radius, fit to content. */
function ActivityCard({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        "w-fit max-w-full overflow-hidden rounded-xl border border-line bg-card text-sm",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** A 36px summary row: icon, verb, detail, trailing status and a chevron that turns when open. */
function ActivitySummary({
  icon,
  verb,
  trailing,
  children,
}: {
  icon: ReactNode;
  verb: string;
  trailing?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <summary className="flex h-9 cursor-pointer list-none items-center gap-2.5 pr-3 pl-3 [&::-webkit-details-marker]:hidden">
      {icon}
      <span className="shrink-0 font-medium">{verb}</span>
      <span className="flex min-w-0 items-center gap-2 truncate">{children}</span>
      {trailing}
      <ChevronDown className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
    </summary>
  );
}

// Maps ACP tool kinds to an icon and a past-tense verb for the activity row ("Edited …/x.tsx").
const TOOL_ICONS: Record<string, typeof Wrench> = {
  read: FileSearch,
  edit: FilePen,
  delete: Trash2,
  move: FolderOpen,
  search: Search,
  execute: Terminal,
  fetch: Globe,
  think: Brain,
};
/** [done, in progress] verbs per tool kind: "Edited …" once completed, "Editing …" while it runs. */
const TOOL_VERBS: Record<string, [string, string]> = {
  read: ["Read", "Reading"],
  edit: ["Edited", "Editing"],
  delete: ["Deleted", "Deleting"],
  move: ["Moved", "Moving"],
  search: ["Searched", "Searching"],
  execute: ["Ran", "Running"],
  fetch: ["Fetched", "Fetching"],
  think: ["Thought", "Thinking"],
};
/** Verbs harnesses already put in front of a title ("Read README.md", "Run: ls"); not repeated. */
const LEADING_VERB = /^(read|edit|edited|run|ran|execute|fetch|search|delete|move|write|grep|bash)\b[:\s]+/i;

function ToolCard({ message: m, fold }: { message: Extract<Message, { kind: "tool_call" }>; fold: Fold }) {
  const d = m.data;
  const Icon = (d.toolKind && TOOL_ICONS[d.toolKind]) || (d.gateway ? Plug : Wrench);
  const done = d.toolStatus === "completed" || d.toolStatus === "failed";
  const verbs =
    (d.toolKind && TOOL_VERBS[d.toolKind]) || (d.gateway ? ["Called", "Calling"] : ["Used", "Using"]);
  const verb = verbs[done ? 0 : 1];
  const title = d.gateway ? gatewayTitle(d.gateway) : d.title.replace(LEADING_VERB, "");
  const needsSignIn = useServerNeedsSignIn(d.toolStatus === "failed" ? d.gateway?.server : undefined);
  const status =
    d.toolStatus === "completed" ? (
      <Check className="size-3.5 shrink-0 text-presence-working" />
    ) : d.toolStatus === "failed" ? (
      <X className="size-3.5 shrink-0 text-destructive" />
    ) : (
      <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
    );
  // One folded card: the first/last rows carry the rounded corners, rows in between draw the
  // divider with their top border, and `w-full` keeps the segments the same width.
  const shape = {
    single: "rounded-xl border w-fit",
    first: "rounded-t-xl border-x border-t w-full",
    middle: "border-x border-t w-full",
    last: "rounded-b-xl border-x border-t border-b w-full",
  }[fold];
  return (
    <div
      data-testid="tool-call"
      data-status={d.toolStatus}
      className={cn(
        "max-w-full overflow-hidden border-line bg-card text-sm",
        fold === "single" ? "" : "sm:max-w-[720px]",
        shape,
      )}
    >
      <details className="group">
        <ActivitySummary
          icon={<Icon className="size-3.5 shrink-0 text-muted-foreground" />}
          verb={verb}
          trailing={status}
        >
          <span className="truncate font-mono text-[12px] text-muted-foreground">{title}</span>
        </ActivitySummary>
        <div className="border-line border-t px-3.5 py-2.5">
          {d.gateway ? (
            <>
              <GatewayCallDetails call={d.gateway} />
              {d.toolStatus === "failed" && !needsSignIn && (
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
                      className="rounded-[6px] bg-muted px-1.5 py-0.5 font-mono text-xs"
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
              {d.rawInput === undefined && d.content.length === 0 && d.rawOutput === undefined && (
                <p className="text-muted-foreground text-xs">No details reported.</p>
              )}
            </>
          )}
        </div>
      </details>
      {needsSignIn && (
        <div
          data-testid="tool-needs-sign-in"
          className="flex items-center gap-2 border-line border-t px-3.5 py-2"
        >
          <span className="flex-1 text-muted-foreground text-xs">
            The "{d.gateway?.server}" MCP server needs sign-in.
          </span>
          <FixInSettingsLink hint="settings:mcp" />
        </div>
      )}
    </div>
  );
}

/** Whether the named upstream server (of a failed gateway call) currently waits for an OAuth sign-in. */
function useServerNeedsSignIn(server: string | undefined): boolean {
  const servers = useMcpServers();
  if (!server) return false;
  return servers.data?.find((s) => s.name === server)?.status.state === "needs_auth";
}

function Pre({ label, value }: { label: string; value: unknown }) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return (
    <div className="space-y-1 pb-2 last:pb-0">
      <div className="vc-label">{label}</div>
      <pre className="vc-scroll max-h-64 overflow-auto rounded-[8px] bg-background px-3 py-2 font-mono text-xs leading-[1.5]">
        {text}
      </pre>
    </div>
  );
}

/**
 * The approval card: amber hairline and glow while pending (the only strong colour in the
 * thread), the request on the base surface, a solid Allow and a ghost Deny. 520px on desktop.
 */
function PermissionCard({
  message: m,
  agentName,
}: {
  message: Extract<Message, { kind: "permission" }>;
  agentName: string;
}) {
  const d = m.data;
  const pending = m.status === "pending";
  const chosen =
    d.outcome && d.outcome !== "cancelled"
      ? d.options.find((o) => o.optionId === (d.outcome as { optionId: string }).optionId)
      : null;
  return (
    <div
      data-testid="permission"
      className={cn(
        "w-full max-w-[520px] overflow-hidden rounded-[14px] border bg-card",
        pending ? "border-presence-waiting/40" : "border-line",
      )}
      style={
        pending
          ? { boxShadow: "0 0 0 3px color-mix(in oklab, var(--presence-waiting) 10%, transparent)" }
          : undefined
      }
    >
      <div className="flex items-center gap-2 px-4 pt-3.5 text-sm">
        <ShieldAlert
          className={cn("size-4 shrink-0", pending ? "text-presence-waiting" : "text-muted-foreground")}
        />
        <span className="font-semibold">
          {pending ? `${agentName} needs approval` : `${agentName} asked for approval`}
        </span>
      </div>
      <code className="mx-4 mt-2.5 block overflow-x-auto whitespace-pre-wrap rounded-[8px] bg-background px-3 py-2 font-mono text-[12.5px] leading-snug">
        {d.title}
      </code>
      {d.rawInput !== undefined && (
        <details className="group mx-4 mt-2 text-xs">
          <summary className="flex cursor-pointer list-none items-center gap-1 text-muted-foreground [&::-webkit-details-marker]:hidden">
            <ChevronDown className="size-3 transition-transform group-open:rotate-180" /> Request details
          </summary>
          <pre className="vc-scroll mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap rounded-[8px] bg-background px-3 py-2 font-mono text-xs">
            {typeof d.rawInput === "string" ? d.rawInput : JSON.stringify(d.rawInput, null, 2)}
          </pre>
        </details>
      )}
      <div className="p-4">
        {pending ? (
          <PermissionButtons message={m} />
        ) : (
          <p className="text-muted-foreground text-xs">
            {chosen ? `Answered: ${chosen.name}` : "No longer needed (the turn ended)"}
          </p>
        )}
      </div>
    </div>
  );
}

/** The answer buttons of a pending permission request (in the DM and in the call card/sheet). */
export function PermissionButtons({ message: m }: { message: Extract<Message, { kind: "permission" }> }) {
  const answer = useAnswerPermission();
  return (
    <div className="flex flex-wrap gap-2">
      {m.data.options.map((o) => (
        <Button
          key={o.optionId}
          className="h-9 min-w-24 flex-1 font-semibold text-[13.5px]"
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
  const label =
    m.data && "reason" in m.data && m.data.reason === "resume_failed"
      ? "New session (previous could not be resumed)"
      : "New session";
  return (
    <Divider
      testId="session-divider"
      title={m.text}
      label={`${label} · ${new Date(m.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`}
    />
  );
}

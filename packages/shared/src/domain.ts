// Domain types shared by server and web. Output shapes are plain TS types (the server produces
// them); inputs the server must validate are zod schemas in api.ts.

export type Id = string;
/** Epoch milliseconds. */
export type Timestamp = number;

// ---- agents -----------------------------------------------------------------------------------

/**
 * What an agent is doing right now. `waiting` = blocked on a permission request from the user.
 * `in_call` is set by the voice layer and overrides the others while a call runs.
 */
export const PRESENCES = ["idle", "thinking", "working", "waiting", "in_call", "error"] as const;
export type Presence = (typeof PRESENCES)[number];

export interface Avatar {
  emoji: string;
  /** #rrggbb */
  color: string;
}

/** Values for harness config options (ACP `session/set_config_option`), keyed by config id. */
export type ConfigValues = Record<string, string | boolean>;

export interface Agent {
  id: Id;
  name: string;
  description: string;
  avatar: Avatar;
  systemPrompt: string;
  harnessId: Id;
  /** Model value for the harness's `model` config option; null = harness default. */
  model: string | null;
  /** Other harness config option values (mode, effort, ...), applied on every session. */
  options: ConfigValues;
  /** Absolute working directory for the agent's harness sessions. */
  cwd: string;
  /** TTS voice for calls (phase 2b). */
  voice: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/** An agent plus its live state, as listed in the sidebar. */
export interface AgentView extends Agent {
  conversationId: Id;
  presence: Presence;
  /** Short human-readable detail for the presence, e.g. the running tool's title or the error. */
  presenceDetail: string | null;
  unread: number;
}

/**
 * A secret-bearing map (env vars, HTTP headers) as the client sees it: keys and a hint, never the
 * value. `hint` is the last 4 characters for values of 12+ characters, else empty. Writes send
 * a new value or `{ keep: true }` per key (`SecretInput`).
 */
export type SecretMap = Record<string, { hint: string }>;

// ---- harnesses --------------------------------------------------------------------------------

export const HARNESS_KINDS = ["claude-code", "opencode", "custom"] as const;
export type HarnessKind = (typeof HARNESS_KINDS)[number];

export type HarnessStatus = "unknown" | "ok" | "not_installed" | "auth_required" | "error";

export interface HarnessHealth {
  status: HarnessStatus;
  message: string | null;
  checkedAt: Timestamp | null;
}

export interface ConfigOptionChoice {
  value: string;
  name: string;
  description?: string | null;
  /** Group name for grouped selects (e.g. a provider in OpenCode). */
  group?: string | null;
}

/** An ACP session config option (`configOptions` in `session/new`), flattened for the UI. */
export type ConfigOption =
  | {
      type: "select";
      id: string;
      name: string;
      description?: string | null;
      category?: string | null;
      currentValue: string;
      options: ConfigOptionChoice[];
    }
  | {
      type: "boolean";
      id: string;
      name: string;
      description?: string | null;
      category?: string | null;
      currentValue: boolean;
    };

/** What probing a harness found out: agent identity, capabilities and its config options. */
export interface HarnessProbe {
  agentName: string | null;
  agentVersion: string | null;
  capabilities: {
    loadSession: boolean;
    resumeSession: boolean;
    systemPrompt: boolean;
    mcpHttp: boolean;
    image: boolean;
  };
  configOptions: ConfigOption[];
  probedAt: Timestamp;
}

export interface Harness {
  id: Id;
  name: string;
  kind: HarnessKind;
  /** Launch command. For presets an empty command means "use the preset's default". */
  command: string;
  args: string[];
  /** Env for the process. Values may be API keys, so they are write-only like MCP secrets. */
  env: SecretMap;
  /** Presets are seeded and cannot be deleted. */
  builtin: boolean;
  health: HarnessHealth;
  probe: HarnessProbe | null;
  /** The command line that will actually run (preset default or override), for display. */
  resolvedCommand: string[];
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ---- conversations, sessions, messages --------------------------------------------------------

/** A DM with one agent. Group channels (later) would be another `kind`. */
export interface Conversation {
  id: Id;
  kind: "dm";
  agentId: Id;
  activeSessionId: Id | null;
  lastReadSeq: number;
  createdAt: Timestamp;
}

/** One ACP session inside a conversation. "New session" ends the active one and starts another. */
export interface Session {
  id: Id;
  conversationId: Id;
  agentId: Id;
  /** The harness's session id once created; reused to resume after restarts. */
  acpSessionId: string | null;
  status: "active" | "ended";
  startedAt: Timestamp;
  endedAt: Timestamp | null;
}

/** Where a prompt came from. Phase 2a/2b add `agent`/`voice` turns through ChatService.prompt. */
export type TurnSource = "user" | "voice" | "agent" | "event";

export type MessageRole = "user" | "agent" | "system";

export type MessageStatus = "streaming" | "complete" | "cancelled" | "error" | "pending";

export interface ToolCallData {
  toolCallId: string;
  title: string;
  toolKind: string | null;
  toolStatus: "pending" | "in_progress" | "completed" | "failed";
  rawInput?: unknown;
  rawOutput?: unknown;
  /** Text rendering of the tool's ACP content blocks (output, diffs, terminal ids). */
  content: string[];
  locations: { path: string; line?: number | null }[];
  /** Set when the call went through the app's MCP gateway (phase 2a). */
  gateway?: GatewayCallInfo;
}

/** A tool call the MCP gateway served, as recorded by the gateway itself. */
export interface GatewayCallInfo {
  callId: string;
  /** Server name (`builtin` for the app's own tools) and the tool's name on that server. */
  server: string;
  tool: string;
  args: unknown;
  /** Text of the result content, once finished. */
  result: string | null;
  isError: boolean;
  status: "running" | "completed" | "failed";
  durationMs: number | null;
}

export interface PermissionOptionData {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

export interface PermissionData {
  requestId: string;
  toolCallId: string;
  title: string;
  toolKind: string | null;
  rawInput?: unknown;
  options: PermissionOptionData[];
  /** null while pending; "cancelled" if the turn ended before the user answered. */
  outcome: { optionId: string } | "cancelled" | null;
}

export interface PlanData {
  entries: { content: string; priority: string; status: string }[];
}

export interface SessionMarkerData {
  reason: "new" | "resume_failed";
}

export interface TurnMeta {
  /** Unset on an agent's own reply message, which carries no source of its own. */
  source?: TurnSource;
  /** Sender for agent-to-agent messages (phase 2a). */
  fromAgentId?: Id | null;
  /**
   * Set on an agent's voice reply (phase 2b) when the worker reports it was barged into after
   * the turn had already finished (so there was nothing left to cancel): the DM shows the full
   * text, but the user may not have heard all of it.
   */
  interrupted?: boolean;
}

interface MessageBase {
  id: Id;
  /** Global, strictly increasing order. Used for pagination and unread counting. */
  seq: number;
  conversationId: Id;
  sessionId: Id;
  turnId: Id | null;
  role: MessageRole;
  status: MessageStatus;
  /** Markdown for text-like kinds; title/summary for the others. FTS-indexed. */
  text: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export type Message = MessageBase &
  (
    | { kind: "text"; data: TurnMeta | null }
    | { kind: "thought"; data: null }
    | { kind: "tool_call"; data: ToolCallData }
    | { kind: "permission"; data: PermissionData }
    | { kind: "plan"; data: PlanData }
    /** Speech-to-text of the user, or the agent's spoken reply, from a call (phase 2b). */
    | { kind: "voice_transcript"; data: TurnMeta | null }
    | { kind: "session"; data: SessionMarkerData }
    | { kind: "error"; data: { stopReason?: string | null; hint?: string | null } | null }
  );

export type MessageKind = Message["kind"];

// ---- devices ----------------------------------------------------------------------------------

export interface Device {
  id: Id;
  name: string;
  userAgent: string | null;
  createdAt: Timestamp;
  lastSeenAt: Timestamp;
  revokedAt: Timestamp | null;
  /** True for the device making the request. */
  current: boolean;
}

// ---- search -----------------------------------------------------------------------------------

export interface MessageSearchHit {
  message: Message;
  agentId: Id;
  /** Snippet with matches wrapped in <mark></mark>. */
  snippet: string;
}

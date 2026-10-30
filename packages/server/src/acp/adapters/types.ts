import type { HarnessKind } from "@vibe-center/shared";
import type { McpSetup } from "../mcp.ts";
import type * as acp from "../protocol.ts";

/** The parts of an agent's configuration an adapter needs. */
export interface AdapterAgent {
  agentId: string;
  cwd: string;
  systemPrompt: string;
  model: string | null;
  /** Private scratch directory for this agent (exists), e.g. for generated harness config. */
  stateDir: string;
}

export interface SessionFieldsContext extends AdapterAgent {
  capabilities: acp.AgentCapabilities;
  mcp: McpSetup;
}

/** Extra fields merged into session/new, session/resume and session/load. */
export interface SessionFields {
  /** Replaces the MCP servers from the McpSetup (e.g. with secrets moved out of the config). */
  mcpServers?: acp.McpServer[];
  systemPrompt?: acp.SystemPrompt;
  _meta?: Record<string, unknown>;
}

/** Auth state an adapter could read from the harness's own notifications. */
export interface AuthReport {
  loggedIn: boolean;
  label: string;
}

/**
 * Hides one harness's quirks behind a common shape. Everything that is plain ACP (session
 * lifecycle, config options, prompts, cancel, permissions) is handled generically by
 * AgentRuntime; adapters only map the agent's persona, model and app tools onto what the
 * harness understands.
 */
export interface HarnessAdapter {
  readonly kind: HarnessKind;
  readonly label: string;
  /** Command line used when the harness config leaves `command` empty. */
  defaultLaunch(): { command: string; args: string[] } | null;
  /** Env (and files under stateDir) the process needs for this agent. Called before each spawn. */
  prepareProcess(agent: AdapterAgent): Promise<{ env: Record<string, string> }>;
  /** Harness-specific session fields: system prompt, model, tool permissions. */
  sessionFields(ctx: SessionFieldsContext): SessionFields;
  /**
   * True if the harness can't take a system prompt at session setup, so the runtime sends it
   * as a preamble block with the first prompt of each session.
   */
  needsPromptPreamble(ctx: SessionFieldsContext): boolean;
  /** Interpret harness extension notifications, e.g. claude-agent-acp's `_auth/status_update`. */
  readAuth?(method: string, params: unknown): AuthReport | null;
}

/** The spec's `systemPrompt` field, when the agent advertises `sessionCapabilities.systemPrompt`. */
export function specSystemPrompt(ctx: SessionFieldsContext): acp.SystemPrompt | undefined {
  if (!ctx.systemPrompt.trim() || !ctx.capabilities.sessionCapabilities?.systemPrompt) return undefined;
  return { mode: "append", content: [{ type: "text", text: ctx.systemPrompt }] };
}

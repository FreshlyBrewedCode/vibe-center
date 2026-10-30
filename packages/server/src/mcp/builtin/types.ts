import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpToolInfo } from "@vibe-center/shared";
import { z } from "zod";
import type { Repos } from "../../db/repos/index.ts";
import type { ChatService, PromptHandle } from "../../domain/chat.ts";
import type { PresenceStore } from "../../domain/presence.ts";
import type { EventBus } from "../../events/bus.ts";

/** Who is calling a built-in tool: the agent and the app session/turn its harness is in. */
export interface ToolContext {
  agentId: string;
  sessionKey: string;
  /** The agent's running turn, if the call came during one (it nearly always does). */
  turnId: string | null;
}

export interface BuiltinDeps {
  repos: Repos;
  bus: EventBus;
  chat: ChatService;
  presence: PresenceStore;
  /**
   * Phase 2b's hook: deliver an event into a running call with the agent (spoken when the line is
   * quiet; `onPrompt` gets the turn once it is prompted). Returns false when there is no call.
   */
  speakEvent?: (
    agentId: string,
    text: string,
    opts: { note?: string; fromAgentId?: string | null; onPrompt?: (handle: PromptHandle) => void },
  ) => boolean;
}

/** An MCP `tools/call` result (built-in results are text only). */
export type ToolResult = CallToolResult;

export interface BuiltinTool {
  name: string;
  description: string;
  schema: z.ZodObject;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> | ToolResult;
}

/** Declare a built-in tool with typed arguments. */
export function tool<S extends z.ZodObject>(def: {
  name: string;
  description: string;
  schema: S;
  run(args: z.output<S>, ctx: ToolContext): Promise<ToolResult> | ToolResult;
}): BuiltinTool {
  return def as unknown as BuiltinTool;
}

export const text = (t: string): ToolResult => ({ content: [{ type: "text", text: t }] });
export const json = (v: unknown): ToolResult => text(JSON.stringify(v, null, 2));
/** An error the model should see and can act on (wrong id, limit reached, ...). */
export class ToolError extends Error {}

export function toolInfo(t: BuiltinTool): McpToolInfo {
  const { $schema: _, ...schema } = z.toJSONSchema(t.schema, { io: "input" }) as Record<string, unknown>;
  return { name: t.name, description: t.description, inputSchema: schema };
}

export const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");

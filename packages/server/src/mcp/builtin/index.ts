import { AgentMessenger, agentTools } from "./agents.ts";
import { conversationTools } from "./conversations.ts";
import { memoryTools } from "./memory.ts";
import type { BuiltinDeps, BuiltinTool } from "./types.ts";
import { watchTools } from "./watches.ts";

export type { BuiltinDeps, BuiltinTool, ToolContext, ToolResult } from "./types.ts";
export { ToolError, toolInfo } from "./types.ts";

/** Sent to harnesses as the gateway's MCP `instructions` (Claude Code puts them in the system prompt). */
export const GATEWAY_INSTRUCTIONS = `Tools from Vibe Center, the app you live in.
- Long-term memory: your sessions start fresh, so search your memories (memory_search) when the user refers to earlier conversations, preferences, people or projects, and save what will matter later (memory_save).
- search_conversations / read_conversation find what was said in earlier sessions.
- list_agents / send_message_to_agent reach the other agents; replies arrive later as their own messages.
- Never block a turn waiting for something: register a background wait and end your turn; you get a new turn when it fires. call_in_background runs a slow or waiting tool (e.g. waiting for a thread's reply) and brings you its result; watch_timer checks back later; watch_webhook gives a URL for a job to call when done.
Tools named <server>__<tool> come from other MCP servers the user configured.`;

/** The app's own tools, in the order the UI lists them. */
export function builtinTools(d: BuiltinDeps): BuiltinTool[] {
  return [
    ...memoryTools(d),
    ...conversationTools(d),
    ...agentTools(d, new AgentMessenger(d)),
    ...watchTools(d),
  ];
}

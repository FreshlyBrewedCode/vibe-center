import { dirname, join } from "node:path";
import type { HarnessAdapter, SessionFieldsContext } from "./types.ts";
import { specSystemPrompt } from "./types.ts";

function adapterEntry(): string {
  // Resolves to dist/lib.js; the CLI entry (its `bin`) sits next to it.
  return join(dirname(Bun.resolveSync("@agentclientprotocol/claude-agent-acp", import.meta.dir)), "index.js");
}

/**
 * Claude Code through @agentclientprotocol/claude-agent-acp, run with node (its shebang).
 * Knobs from spikes/acp-latency/FINDINGS.md:
 * - persona appended to the Claude Code preset (spec `systemPrompt`, else `_meta.systemPrompt`)
 * - model and Claude Agent SDK options through `_meta.claudeCode.options`
 * - ENABLE_TOOL_SEARCH=false: otherwise the first use of each MCP tool costs an extra model call
 * - the app's MCP tools pre-allowed, so they don't trigger a permission round trip
 * - prompt suggestions off (they cost tokens after every turn)
 * Auth uses the `claude` CLI login (~/.claude); the adapter reports it via `_auth/status_update`.
 */
export const claudeCodeAdapter: HarnessAdapter = {
  kind: "claude-code",
  label: "Claude Code",

  defaultLaunch: () => ({ command: "node", args: [adapterEntry()] }),

  prepareProcess: async () => ({ env: {} }),

  sessionFields(ctx: SessionFieldsContext) {
    const systemPrompt = specSystemPrompt(ctx);
    const options: Record<string, unknown> = {
      env: { ENABLE_TOOL_SEARCH: "false" },
      promptSuggestions: false,
    };
    if (ctx.model) options.model = ctx.model;
    if (ctx.mcp.allowedTools.length) options.allowedTools = ctx.mcp.allowedTools;
    const meta: Record<string, unknown> = { claudeCode: { options } };
    if (!systemPrompt && ctx.systemPrompt.trim()) meta.systemPrompt = { append: ctx.systemPrompt };
    return { ...(systemPrompt ? { systemPrompt } : {}), _meta: meta };
  },

  needsPromptPreamble: () => false,

  readAuth(method, params) {
    if (method !== "_auth/status_update") return null;
    const status = (params as { authStatus?: { kind?: string; label?: string } } | null)?.authStatus;
    if (!status?.kind) return null;
    return { loggedIn: status.kind !== "none", label: status.label ?? status.kind };
  },
};

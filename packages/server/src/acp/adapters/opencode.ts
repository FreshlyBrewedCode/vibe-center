import { join } from "node:path";
import type { HarnessAdapter } from "./types.ts";

/**
 * OpenCode (`opencode acp`). It has no ACP system-prompt capability, so the persona goes in
 * through OpenCode's own config: an `instructions` file (appended to OpenCode's prompt, like
 * an AGENTS.md) passed inline with OPENCODE_CONFIG_CONTENT. That leaves the agent's working
 * directory untouched. The model is a regular ACP config option (handled by the runtime).
 * OpenCode can hang forever on provider errors; the runtime's per-prompt timeout covers it.
 */
export const opencodeAdapter: HarnessAdapter = {
  kind: "opencode",
  label: "OpenCode",

  defaultLaunch: () => ({ command: "opencode", args: ["acp"] }),

  async prepareProcess(agent): Promise<{ env: Record<string, string> }> {
    if (!agent.systemPrompt.trim()) return { env: {} };
    const file = join(agent.stateDir, "opencode-instructions.md");
    await Bun.write(file, `${agent.systemPrompt.trim()}\n`);
    return { env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ instructions: [file] }) } };
  },

  sessionFields: () => ({}),

  needsPromptPreamble: () => false,
};

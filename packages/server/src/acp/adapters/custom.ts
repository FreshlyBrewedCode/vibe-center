import type { HarnessAdapter } from "./types.ts";
import { specSystemPrompt } from "./types.ts";

/**
 * Any ACP agent: command, args and env come from the harness config. Only spec features are
 * used: the system prompt goes in `systemPrompt` if the agent advertises it, else as a
 * preamble block on the first prompt of each session.
 */
export const customAdapter: HarnessAdapter = {
  kind: "custom",
  label: "Custom",
  defaultLaunch: () => null,
  prepareProcess: async () => ({ env: {} }),
  sessionFields(ctx) {
    const systemPrompt = specSystemPrompt(ctx);
    return systemPrompt ? { systemPrompt } : {};
  },
  needsPromptPreamble: (ctx) =>
    !!ctx.systemPrompt.trim() && !ctx.capabilities.sessionCapabilities?.systemPrompt,
};

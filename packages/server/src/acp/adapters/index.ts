import type { HarnessKind } from "@vibe-center/shared";
import type { LaunchSpec } from "../process.ts";
import { claudeCodeAdapter } from "./claude-code.ts";
import { customAdapter } from "./custom.ts";
import { opencodeAdapter } from "./opencode.ts";
import type { HarnessAdapter } from "./types.ts";

export type {
  AdapterAgent,
  AuthReport,
  HarnessAdapter,
  SessionFields,
  SessionFieldsContext,
} from "./types.ts";

export const adapters: Record<HarnessKind, HarnessAdapter> = {
  "claude-code": claudeCodeAdapter,
  opencode: opencodeAdapter,
  custom: customAdapter,
};

/** Harness config as stored (command may be empty for presets = use the default). */
export interface HarnessLaunchConfig {
  kind: HarnessKind;
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** The command line a harness config runs, or null if it has none (custom without command). */
export function resolveCommand(h: HarnessLaunchConfig): { command: string; args: string[] } | null {
  if (h.command.trim()) return { command: h.command.trim(), args: h.args };
  const def = adapters[h.kind].defaultLaunch();
  return def ? { command: def.command, args: [...def.args, ...h.args] } : null;
}

export function launchSpec(
  h: HarnessLaunchConfig,
  cwd: string,
  extraEnv: Record<string, string> = {},
): LaunchSpec {
  const cmd = resolveCommand(h);
  if (!cmd) throw new Error("harness has no command configured");
  return { command: cmd.command, args: cmd.args, env: { ...h.env, ...extraEnv }, cwd };
}

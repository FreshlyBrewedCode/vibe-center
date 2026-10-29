import type { ConfigOption, ConfigOptionChoice, ConfigValues } from "@vibe-center/shared";
import type * as acp from "./protocol.ts";

/** Flatten ACP config options (grouped selects become choices with a `group`). */
export function toConfigOptions(options: acp.SessionConfigOption[] | null | undefined): ConfigOption[] {
  return (options ?? []).map((o): ConfigOption => {
    const base = { id: o.id, name: o.name, description: o.description ?? null, category: o.category ?? null };
    if (o.type === "boolean") return { ...base, type: "boolean", currentValue: o.currentValue };
    const choices: ConfigOptionChoice[] = [];
    for (const entry of o.options) {
      if ("group" in entry) {
        for (const c of entry.options) {
          choices.push({
            value: c.value,
            name: c.name,
            description: c.description ?? null,
            group: entry.name,
          });
        }
      } else {
        choices.push({ value: entry.value, name: entry.name, description: entry.description ?? null });
      }
    }
    return { ...base, type: "select", currentValue: o.currentValue, options: choices };
  });
}

/** The option that selects the model: category "model", else id "model". */
export function modelOption<T extends { id: string; category?: string | null }>(options: T[]): T | undefined {
  return options.find((o) => o.category === "model") ?? options.find((o) => o.id === "model");
}

/**
 * The `session/set_config_option` calls needed to move a session from its current config to the
 * agent's desired one. Values the harness doesn't offer are skipped (and reported), so a stale
 * model id never breaks a session.
 */
export function configChanges(
  current: acp.SessionConfigOption[],
  desired: { model: string | null; options: ConfigValues },
): { changes: { configId: string; value: string | boolean }[]; skipped: string[] } {
  const wanted: Record<string, string | boolean> = { ...desired.options };
  const model = modelOption(current);
  if (desired.model && model) wanted[model.id] = desired.model;
  const changes: { configId: string; value: string | boolean }[] = [];
  const skipped: string[] = [];
  for (const [configId, value] of Object.entries(wanted)) {
    const opt = current.find((o) => o.id === configId);
    if (!opt) {
      skipped.push(`${configId} (not offered by the harness)`);
      continue;
    }
    if (opt.currentValue === value) continue;
    if (opt.type === "boolean") {
      if (typeof value === "boolean") changes.push({ configId, value });
      else skipped.push(`${configId}=${value} (expects a boolean)`);
      continue;
    }
    const values = toConfigOptions([opt])[0];
    const offered = values?.type === "select" && values.options.some((c) => c.value === value);
    if (typeof value === "string" && offered) changes.push({ configId, value });
    else skipped.push(`${configId}=${String(value)} (not offered)`);
  }
  return { changes, skipped };
}

export function setConfigParams(
  sessionId: string,
  change: { configId: string; value: string | boolean },
): acp.SetSessionConfigOptionRequest {
  return typeof change.value === "boolean"
    ? { sessionId, configId: change.configId, type: "boolean", value: change.value }
    : { sessionId, configId: change.configId, value: change.value };
}

import type {
  ConfigOption,
  Harness,
  HarnessHealth,
  HarnessInput,
  HarnessKind,
  HarnessPatchBody,
} from "@vibe-center/shared";
import { type HarnessLaunchConfig, resolveCommand } from "../acp/adapters/index.ts";
import { probeHarness } from "../acp/probe.ts";
import { newId } from "../db/index.ts";
import type { HarnessRecord } from "../db/repos/harnesses.ts";
import type { Repos } from "../db/repos/index.ts";
import type { EventBus } from "../events/bus.ts";
import type { ProcessTracker } from "../procs.ts";
import { HttpError } from "./errors.ts";
import { maskSecrets, resolveSecrets } from "./secrets.ts";

/** Preset harnesses, seeded on first start. Their ids double as stable references. */
const PRESETS: { id: string; name: string; kind: HarnessKind }[] = [
  { id: "claude-code", name: "Claude Code", kind: "claude-code" },
  { id: "opencode", name: "OpenCode", kind: "opencode" },
];

/**
 * Harness configs, their health and their cached probe (models and other config options).
 * Probes run on start (if enabled), on demand from settings, and the cache is refreshed for free
 * whenever a live session reports its config options.
 */
export class HarnessService {
  private probing = new Map<string, Promise<Harness>>();

  constructor(
    private readonly repos: Repos,
    private readonly bus: EventBus,
    private readonly tracker?: ProcessTracker,
  ) {
    for (const p of PRESETS) {
      if (!repos.harnesses.get(p.id)) {
        repos.harnesses.insert({ ...p, command: "", args: [], env: {}, builtin: true });
      }
    }
  }

  list(): Harness[] {
    return this.repos.harnesses.list().map(toHarness);
  }

  get(id: string): Harness | null {
    const h = this.repos.harnesses.get(id);
    return h ? toHarness(h) : null;
  }

  require(id: string): Harness {
    const h = this.get(id);
    if (!h) throw new HttpError(404, `harness not found: ${id}`);
    return h;
  }

  /** What it takes to start the harness, env values included. Server side only. */
  launch(id: string): HarnessLaunchConfig | null {
    const rec = this.repos.harnesses.get(id);
    return rec ? launchConfig(rec) : null;
  }

  /** User-defined harnesses are always `custom`; presets are seeded. */
  create(body: HarnessInput): Harness {
    if (!body.command.trim()) throw new HttpError(400, "a custom harness needs a command");
    const rec = this.repos.harnesses.insert({
      id: newId(),
      name: body.name,
      kind: "custom",
      command: body.command,
      args: body.args,
      env: resolveSecrets(body.env, {}),
      builtin: false,
    });
    return this.publish(rec.id);
  }

  update(id: string, patch: HarnessPatchBody): Harness {
    const cur = this.require(id);
    if (cur.kind === "custom" && patch.command !== undefined && !patch.command.trim()) {
      throw new HttpError(400, "a custom harness needs a command");
    }
    const stored = this.repos.harnesses.get(id)?.env ?? {};
    const { env, ...rest } = patch;
    this.repos.harnesses.update(id, { ...rest, ...(env ? { env: resolveSecrets(env, stored) } : {}) });
    return this.publish(id);
  }

  delete(id: string): void {
    const h = this.require(id);
    if (h.builtin) throw new HttpError(400, "preset harnesses can't be deleted");
    if (this.repos.agents.countByHarness(id) > 0) {
      throw new HttpError(409, "agents still use this harness");
    }
    this.repos.harnesses.delete(id);
  }

  /** Start the harness, read its capabilities and config options, cache them. Deduplicated. */
  probe(id: string, opts: { deep?: boolean } = {}): Promise<Harness> {
    const running = this.probing.get(id);
    if (running) return running;
    const h = this.require(id);
    const launch = this.launch(id)!;
    const p = (async () => {
      this.repos.harnesses.setHealth(id, { ...h.health, status: "unknown", message: "checking…" });
      this.publish(id);
      const result = await probeHarness(launch, { ...opts, tracker: this.tracker });
      this.repos.harnesses.setHealth(id, result.health);
      if (result.probe) this.repos.harnesses.setProbe(id, result.probe);
      return this.publish(id);
    })().finally(() => this.probing.delete(id));
    this.probing.set(id, p);
    return p;
  }

  /** Probe every harness in the background (on server start). */
  probeAll(): void {
    for (const h of this.repos.harnesses.list()) {
      void this.probe(h.id).catch((e) => console.error(`probe ${h.id} failed`, e));
    }
  }

  /** A live session reported its config options: keep the cached probe current. */
  noteConfigOptions(id: string, configOptions: ConfigOption[]): void {
    const h = this.repos.harnesses.get(id);
    if (!h?.probe || JSON.stringify(h.probe.configOptions) === JSON.stringify(configOptions)) return;
    this.repos.harnesses.setProbe(id, { ...h.probe, configOptions, probedAt: Date.now() });
    this.publish(id);
  }

  setHealth(id: string, health: HarnessHealth): void {
    const h = this.repos.harnesses.get(id);
    if (!h || (h.health.status === health.status && h.health.message === health.message)) return;
    this.repos.harnesses.setHealth(id, health);
    this.publish(id);
  }

  private publish(id: string): Harness {
    const harness = this.require(id);
    this.bus.publish({ type: "harness.upsert", harness });
    return harness;
  }
}

export function launchConfig(
  h: Pick<HarnessRecord, "kind" | "command" | "args" | "env">,
): HarnessLaunchConfig {
  return { kind: h.kind, command: h.command, args: h.args, env: h.env };
}

/** The client's view: env values masked (they may be API keys). */
function toHarness(rec: HarnessRecord): Harness {
  const cmd = resolveCommand(launchConfig(rec));
  return { ...rec, env: maskSecrets(rec.env), resolvedCommand: cmd ? [cmd.command, ...cmd.args] : [] };
}

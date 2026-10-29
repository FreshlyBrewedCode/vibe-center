import type { Presence } from "@vibe-center/shared";
import type { EventBus } from "../events/bus.ts";

interface Entry {
  presence: Presence;
  detail: string | null;
}

/**
 * Live presence per agent. The runtime layer reports idle/thinking/working/waiting/error;
 * other layers can put an override on top (phase 2b sets `in_call` while a call runs), which
 * wins until it is cleared. Publishes `agent.presence` whenever the visible value changes.
 */
export class PresenceStore {
  private base = new Map<string, Entry>();
  private overrides = new Map<string, Entry>();

  constructor(private readonly bus: EventBus) {}

  get(agentId: string): Entry {
    return this.overrides.get(agentId) ?? this.base.get(agentId) ?? { presence: "idle", detail: null };
  }

  set(agentId: string, presence: Presence, detail: string | null = null): void {
    this.change(agentId, () => this.base.set(agentId, { presence, detail }));
  }

  setOverride(agentId: string, override: Entry | null): void {
    this.change(agentId, () => {
      if (override) this.overrides.set(agentId, override);
      else this.overrides.delete(agentId);
    });
  }

  forget(agentId: string): void {
    this.base.delete(agentId);
    this.overrides.delete(agentId);
  }

  private change(agentId: string, apply: () => void): void {
    const before = this.get(agentId);
    apply();
    const after = this.get(agentId);
    if (before.presence !== after.presence || before.detail !== after.detail) {
      this.bus.publish({ type: "agent.presence", agentId, ...after });
    }
  }
}

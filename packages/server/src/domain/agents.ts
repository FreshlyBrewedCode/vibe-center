import { existsSync, statSync } from "node:fs";
import type { Agent, AgentInput, AgentPatchBody, AgentView } from "@vibe-center/shared";
import { expandHome } from "../config.ts";
import { newId } from "../db/index.ts";
import type { Repos } from "../db/repos/index.ts";
import type { EventBus } from "../events/bus.ts";
import type { ChatService } from "./chat.ts";
import { HttpError } from "./errors.ts";
import type { HarnessService } from "./harnesses.ts";
import type { PresenceStore } from "./presence.ts";

/** Agent CRUD. Every agent has exactly one DM conversation, created with it. */
export class AgentService {
  constructor(
    private readonly repos: Repos,
    private readonly bus: EventBus,
    private readonly presence: PresenceStore,
    private readonly harnesses: HarnessService,
    private readonly chat: ChatService,
  ) {}

  list(): AgentView[] {
    return this.repos.agents.list().map((a) => this.view(a));
  }

  get(id: string): AgentView {
    const a = this.repos.agents.get(id);
    if (!a) throw new HttpError(404, `agent not found: ${id}`);
    return this.view(a);
  }

  create(input: AgentInput): AgentView {
    this.validate(input);
    const id = newId();
    const agent = this.repos.db.transaction(() => {
      const a = this.repos.agents.insert(id, input);
      const conv = this.repos.conversations.createDm(a.id);
      this.repos.conversations.createSession(conv.id, a.id);
      return a;
    })();
    return this.publish(agent);
  }

  update(id: string, patch: AgentPatchBody): AgentView {
    const cur = this.repos.agents.get(id);
    if (!cur) throw new HttpError(404, `agent not found: ${id}`);
    const next = { ...cur, ...stripUndefined(patch) };
    this.validate(next);
    const agent = this.repos.agents.update(id, next)!;
    this.chat.reconfigure(id);
    return this.publish(agent);
  }

  async delete(id: string): Promise<void> {
    this.get(id);
    await this.chat.disposeAgent(id);
    this.repos.agents.delete(id);
    this.bus.publish({ type: "agent.deleted", agentId: id });
  }

  view(a: Agent): AgentView {
    const conv = this.repos.conversations.dmFor(a.id) ?? this.repos.conversations.createDm(a.id);
    const p = this.presence.get(a.id);
    return {
      ...a,
      conversationId: conv.id,
      presence: p.presence,
      presenceDetail: p.detail,
      unread: this.repos.messages.unreadCount(conv.id, conv.lastReadSeq),
    };
  }

  private validate(a: Pick<Agent, "harnessId" | "cwd">): void {
    if (!this.harnesses.get(a.harnessId)) throw new HttpError(400, `unknown harness: ${a.harnessId}`);
    const cwd = expandHome(a.cwd);
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      throw new HttpError(400, `working directory does not exist: ${a.cwd}`);
    }
  }

  private publish(a: Agent): AgentView {
    const agent = this.view(a);
    this.bus.publish({ type: "agent.upsert", agent });
    return agent;
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

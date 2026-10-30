import type { Agent } from "@vibe-center/shared";
import { z } from "zod";
import type { PromptHandle } from "../../domain/chat.ts";
import { type BuiltinDeps, type BuiltinTool, json, ToolError, text, tool } from "./types.ts";

/**
 * Agent-to-agent messages are a chain: the user prompts A (hop 0), A messages B (hop 1), B
 * messages C (hop 2). A reply delivered back into the sender's session keeps the hop of the
 * message it answers, so a ping-pong between two agents climbs one hop per round trip and stops
 * at the limit.
 */
export const MAX_HOPS = 3;
/** Messages an agent may have waiting for a reply at once. */
export const MAX_PENDING_PER_AGENT = 5;

/**
 * Sends a message to another agent through ChatService.prompt and delivers the reply back into
 * the sender's session later, as an `event` prompt. Hop counts are tracked per turn in memory
 * (turns don't survive a restart anyway).
 */
export class AgentMessenger {
  private hops = new Map<string, number>();
  private pending = new Map<string, number>();

  constructor(private readonly d: BuiltinDeps) {}

  /** Returns as soon as the message is queued for the target. */
  send(from: Agent, to: Agent, message: string, fromTurnId: string | null): { hop: number } {
    if (from.id === to.id) throw new ToolError("you can't send a message to yourself");
    const hop = (fromTurnId ? (this.hops.get(fromTurnId) ?? 0) : 0) + 1;
    if (hop > MAX_HOPS) {
      throw new ToolError(
        `not sent: this conversation between agents is already ${MAX_HOPS} messages deep (limit). Answer with what you have instead of asking further.`,
      );
    }
    const waiting = this.pending.get(from.id) ?? 0;
    if (waiting >= MAX_PENDING_PER_AGENT) {
      throw new ToolError(`not sent: ${waiting} of your messages are still waiting for replies`);
    }
    this.pending.set(from.id, waiting + 1);

    const handle = this.d.chat.prompt(to.id, {
      text: message,
      source: "agent",
      fromAgentId: from.id,
      note: `[Message from the agent "${from.name}" (not the user), sent with send_message_to_agent. Answer it directly; your reply goes back to ${from.name} automatically.]`,
    });
    this.hops.set(handle.turnId, hop);

    void handle.done
      .then((r) => {
        const reply =
          r.status === "complete"
            ? r.text.trim() || "(no text reply)"
            : `(${to.name} could not answer: ${r.error ?? r.status})`;
        this.deliver(from, to, message, reply, hop);
      })
      .catch((e) => this.deliver(from, to, message, `(${to.name} could not answer: ${String(e)})`, hop))
      .finally(() => {
        this.hops.delete(handle.turnId);
        const n = (this.pending.get(from.id) ?? 1) - 1;
        if (n > 0) this.pending.set(from.id, n);
        else this.pending.delete(from.id);
      });
    return { hop };
  }

  private deliver(from: Agent, to: Agent, original: string, reply: string, hop: number): void {
    if (!this.d.repos.agents.get(from.id)) return; // sender deleted meanwhile
    const quoted = original.length > 200 ? `${original.slice(0, 200)}…` : original;
    const note = `[Reply from the agent "${to.name}" to the message you sent with send_message_to_agent: "${quoted}". Continue with what you were doing for the user; tell them the outcome if it matters.]`;
    const track = (handle: PromptHandle) => {
      this.hops.set(handle.turnId, hop);
      void handle.done.finally(() => this.hops.delete(handle.turnId));
    };
    try {
      // in a call with the sender: spoken there once nobody is talking (same turn otherwise)
      if (this.d.speakEvent?.(from.id, reply, { note, fromAgentId: to.id, onPrompt: track })) return;
      track(this.d.chat.prompt(from.id, { text: reply, source: "event", fromAgentId: to.id, note }));
    } catch (e) {
      console.error("could not deliver an agent reply", e);
    }
  }
}

/** list_agents and send_message_to_agent (manager ground work). */
export function agentTools(d: BuiltinDeps, messenger: AgentMessenger): BuiltinTool[] {
  const find = (ref: string): Agent => {
    const all = d.repos.agents.list();
    const a =
      all.find((x) => x.id === ref) ??
      all.find((x) => x.name.toLowerCase() === ref.trim().toLowerCase().replace(/^@/, ""));
    if (!a) throw new ToolError(`no agent named "${ref}". Use list_agents to see who exists.`);
    return a;
  };
  return [
    tool({
      name: "list_agents",
      description: "List the other agents in this workspace: name, what they do, and whether they're busy.",
      schema: z.object({}),
      run(_, ctx) {
        return json(
          d.repos.agents.list().map((a) => ({
            id: a.id,
            name: a.name,
            ...(a.id === ctx.agentId ? { you: true } : {}),
            description: a.description,
            presence: d.presence.get(a.id).presence,
          })),
        );
      },
    }),
    tool({
      name: "send_message_to_agent",
      description: `Send a message to another agent (see list_agents), e.g. to delegate a task or ask a question. Returns immediately. The agent works on it in its own conversation and its reply arrives later as a separate message in this conversation; don't wait or poll for it, carry on or end your turn. Write the message so it stands on its own: the other agent doesn't see this conversation.`,
      schema: z.object({
        agent: z.string().min(1).describe("Name or id of the agent."),
        message: z.string().min(1).max(20_000),
      }),
      run({ agent, message }, ctx) {
        const from = d.repos.agents.get(ctx.agentId);
        if (!from) throw new ToolError("unknown sender");
        const to = find(agent);
        messenger.send(from, to, message, ctx.turnId);
        return text(`Sent to ${to.name}. Their reply will arrive as a separate message later.`);
      },
    }),
  ];
}

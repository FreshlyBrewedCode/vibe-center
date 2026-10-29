import { z } from "zod";
import type { FoundMessage } from "../../db/repos/message-search.ts";
import { type BuiltinDeps, type BuiltinTool, iso, json, ToolError, text, tool } from "./types.ts";

const date = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), "an ISO date, e.g. 2026-10-01")
  .transform((s) => Date.parse(s));

/** Conversation search over every DM's history (the phase 1 FTS index). */
export function conversationTools(d: BuiltinDeps): BuiltinTool[] {
  const agentName = (id: string) => d.repos.agents.get(id)?.name ?? "deleted agent";
  const sender = (m: FoundMessage) => {
    if (m.role === "agent") return agentName(m.agentId);
    if (m.source === "agent" && m.fromAgentId) return `${agentName(m.fromAgentId)} (agent)`;
    if (m.source === "event" && m.fromAgentId) return `${agentName(m.fromAgentId)} (reply)`;
    return m.role === "system" ? "system" : "user";
  };
  const resolveAgent = (ref: string): string => {
    const all = d.repos.agents.list();
    const a = all.find((x) => x.id === ref) ?? all.find((x) => x.name.toLowerCase() === ref.toLowerCase());
    if (!a) throw new ToolError(`no agent named "${ref}" (see list_agents)`);
    return a.id;
  };

  return [
    tool({
      name: "search_conversations",
      description: `Search past messages by keywords: what the user or an agent said earlier, possibly in a previous session. By default only your own conversation with the user; set scope "all" to search every agent's conversations. Use read_conversation with a hit's id to see the surrounding messages.`,
      schema: z.object({
        query: z.string().min(1).describe("Keywords; any word may match, best matches first."),
        scope: z.enum(["own", "all"]).optional().describe("'own' (default) or 'all' agents."),
        agent: z
          .string()
          .optional()
          .describe("Only this agent's conversation (name or id); implies scope all."),
        role: z
          .enum(["user", "agent"])
          .optional()
          .describe("Only messages from the user side or the agent side."),
        since: date.optional().describe("ISO date/time; only messages after it."),
        until: date.optional().describe("ISO date/time; only messages before it."),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      run(a, ctx) {
        const agentId = a.agent ? resolveAgent(a.agent) : a.scope === "all" ? undefined : ctx.agentId;
        const hits = d.repos.messageSearch.search(a.query, {
          agentId,
          role: a.role,
          since: a.since,
          until: a.until,
          excludeTurnId: ctx.turnId,
          limit: a.limit ?? 10,
        });
        if (!hits.length) return text(`No messages match "${a.query}".`);
        return json(
          hits.map((m) => ({
            id: m.id,
            conversation: `DM with ${agentName(m.agentId)}`,
            from: sender(m),
            at: iso(m.createdAt),
            snippet: m.snippet,
          })),
        );
      },
    }),
    tool({
      name: "read_conversation",
      description:
        "Read the messages around one message (e.g. a search_conversations hit), to get its full context.",
      schema: z.object({
        message_id: z.string().min(1),
        before: z.number().int().min(0).max(50).optional().describe("Messages before it (default 5)."),
        after: z.number().int().min(0).max(50).optional().describe("Messages after it (default 5)."),
      }),
      run({ message_id, before, after }) {
        const hit = d.repos.messageSearch.get(message_id);
        if (!hit) throw new ToolError(`no message with id ${message_id}`);
        const window = d.repos.messageSearch.around(hit, before ?? 5, after ?? 5);
        const lines = window.map(
          (m) =>
            `${m.id === hit.id ? ">>> " : ""}[${iso(m.createdAt)}] ${sender(m)}: ${
              m.text.length > 4000 ? `${m.text.slice(0, 4000)}…` : m.text
            }`,
        );
        return text(`DM with ${agentName(hit.agentId)}:\n\n${lines.join("\n\n")}`);
      },
    }),
  ];
}

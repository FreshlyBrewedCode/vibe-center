import type { Memory } from "@vibe-center/shared";
import { z } from "zod";
import type { MemoryScope } from "../../db/repos/memories.ts";
import { type BuiltinDeps, type BuiltinTool, iso, json, ToolError, text, tool } from "./types.ts";

const scopeArg = z
  .enum(["agent", "shared"])
  .describe(
    "'agent' (default): only you see it. 'shared': every agent sees it (facts about the user, team conventions).",
  );
const tagsArg = z
  .array(z.string().min(1).max(40))
  .max(10)
  .describe("Short keywords to find it by, e.g. ['preference', 'project-x'].");

const view = (m: Memory, self: string) => ({
  id: m.id,
  scope: m.agentId === null ? "shared" : m.agentId === self ? "agent" : "other",
  content: m.content,
  tags: m.tags,
  updated: iso(m.updatedAt),
});

/** Long-term memory: the agent's own memories and shared ones. */
export function memoryTools(d: BuiltinDeps): BuiltinTool[] {
  const publish = (m: Memory) => d.bus.publish({ type: "memory.upsert", memory: m });
  const owned = (id: string, agentId: string): Memory => {
    const m = d.repos.memories.get(id);
    if (!m || (m.agentId !== null && m.agentId !== agentId)) {
      throw new ToolError(`no memory with id ${id} (you can change your own and shared memories)`);
    }
    return m;
  };
  const listScope = (scope: string | undefined, agentId: string): MemoryScope =>
    scope === "agent"
      ? { kind: "agent", agentId }
      : scope === "shared"
        ? { kind: "shared" }
        : { kind: "visibleTo", agentId };

  return [
    tool({
      name: "memory_save",
      description: `Save a long-term memory. Your future sessions start without this conversation, so this is how you remember.
Save when: the user tells you about themselves, their preferences, people or projects; the user corrects you or says "remember"/"always"/"never"; a decision is made; you learn something non-obvious that took effort to find (a gotcha, where something lives, how to run something).
Don't save: secrets, temporary task state, things already written in the code or docs.
Write one self-contained fact per memory, so it makes sense without this conversation (names, not "he"). Search first; if a memory on it exists, use memory_update instead of saving a duplicate.`,
      schema: z.object({
        content: z.string().min(1).max(4000).describe("The fact, in one or a few sentences."),
        scope: scopeArg.optional(),
        tags: tagsArg.optional(),
      }),
      run({ content, scope, tags }, ctx) {
        const m = d.repos.memories.insert({
          agentId: scope === "shared" ? null : ctx.agentId,
          content: content.trim(),
          tags: tags ?? [],
        });
        publish(m);
        return text(`Saved memory ${m.id} (${scope === "shared" ? "shared" : "only you"}).`);
      },
    }),
    tool({
      name: "memory_search",
      description: `Search your long-term memories (your own and shared ones) by keywords. Do this before asking the user something they may have told you before, when they refer to the past ("like last time", "as I said", "my usual"), when a person, project or preference comes up, and at the start of a non-trivial task. Use a few distinctive words; any word may match.`,
      schema: z.object({
        query: z.string().min(1).describe("Keywords, e.g. 'favourite editor' or 'deploy staging'."),
        scope: z.enum(["agent", "shared", "all"]).optional().describe("Default 'all' (yours and shared)."),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      run({ query, scope, limit }, ctx) {
        const hits = d.repos.memories.search(query, listScope(scope, ctx.agentId), limit ?? 10);
        if (!hits.length) return text(`No memories match "${query}".`);
        return json(hits.map((m) => view(m, ctx.agentId)));
      },
    }),
    tool({
      name: "memory_list",
      description: "List your memories, newest first, e.g. to review what you know or to clean up.",
      schema: z.object({
        scope: z.enum(["agent", "shared", "all"]).optional().describe("Default 'all' (yours and shared)."),
        tag: z.string().optional().describe("Only memories with this tag."),
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional(),
      }),
      run({ scope, tag, limit, offset }, ctx) {
        const list = d.repos.memories.list(listScope(scope, ctx.agentId), {
          limit: limit ?? 20,
          offset,
          tag,
        });
        if (!list.length) return text("No memories yet.");
        return json(list.map((m) => view(m, ctx.agentId)));
      },
    }),
    tool({
      name: "memory_update",
      description:
        "Change a memory that is outdated, incomplete or wrong (prefer this over saving a near-duplicate).",
      schema: z.object({
        id: z.string().min(1),
        content: z.string().min(1).max(4000).optional(),
        tags: tagsArg.optional(),
        scope: scopeArg.optional().describe("Move it between your own and the shared memories."),
      }),
      run({ id, content, tags, scope }, ctx) {
        owned(id, ctx.agentId);
        const m = d.repos.memories.update(id, {
          content: content?.trim(),
          tags,
          agentId: scope === undefined ? undefined : scope === "shared" ? null : ctx.agentId,
        })!;
        publish(m);
        return text(`Updated memory ${id}.`);
      },
    }),
    tool({
      name: "memory_delete",
      description: "Delete a memory that is wrong or no longer true (e.g. the user changed their mind).",
      schema: z.object({ id: z.string().min(1) }),
      run({ id }, ctx) {
        owned(id, ctx.agentId);
        d.repos.memories.delete(id);
        d.bus.publish({ type: "memory.deleted", memoryId: id });
        return text(`Deleted memory ${id}.`);
      },
    }),
  ];
}

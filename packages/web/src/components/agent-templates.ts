import type { AgentBody } from "@vibe-center/shared";

/** One built-in tool to switch on/off after create (server is always the app's `builtin` one). */
export interface TemplateTool {
  tool: string;
  enabled: boolean;
}

export interface AgentTemplate {
  id: "coding" | "manager" | "blank";
  name: string;
  description: string;
  emoji: string;
  blurb: string;
  defaults: Pick<AgentBody, "avatar" | "systemPrompt" | "description" | "harnessId" | "voice">;
  /** Case-insensitive substring to prefer in the harness's probed model list, once it's known. */
  modelPreference?: string;
  /** Built-in tool overrides applied via `PATCH /agents/:id/tools` right after create. */
  tools?: TemplateTool[];
}

const AGENTS_TOOLS: TemplateTool[] = [
  { tool: "list_agents", enabled: true },
  { tool: "send_message_to_agent", enabled: true },
];

const MEMORY_TOOLS: TemplateTool[] = [
  { tool: "memory_save", enabled: true },
  { tool: "memory_search", enabled: true },
  { tool: "memory_list", enabled: true },
  { tool: "memory_update", enabled: true },
  { tool: "memory_delete", enabled: true },
];

const SEARCH_TOOLS: TemplateTool[] = [
  { tool: "search_conversations", enabled: true },
  { tool: "read_conversation", enabled: true },
];

export const AGENT_TEMPLATES: AgentTemplate[] = [
  {
    id: "coding",
    name: "Coding agent",
    description: "Works in a repo: reads, edits, runs commands, asks before anything risky.",
    emoji: "🛠️",
    blurb: "Best with Claude Code or OpenCode pointed at a project's working directory.",
    defaults: {
      avatar: { emoji: "🛠️", color: "#6366f1" },
      description: "Works in a codebase: reads, edits, runs commands.",
      harnessId: "claude-code",
      voice: "am_michael",
      systemPrompt: `You are a careful, direct coding assistant working in this repository.

- Read before you write: understand the existing code and conventions before changing anything.
- Make the smallest change that correctly solves the problem; don't refactor unrelated code.
- Explain what you changed and why in a couple of sentences, not a wall of text.
- Ask before destructive or hard-to-reverse actions (deleting files, force-pushing, dropping data).
- If you're unsure which of two reasonable approaches to take, say so and pick one rather than stalling.`,
    },
    modelPreference: "sonnet",
    // A solo coding agent doesn't need to message other agents; memory and search help it work
    // across sessions. Mirrors the "agents off by default outside Manager" trust-model note.
    tools: [...AGENTS_TOOLS.map((t) => ({ ...t, enabled: false })), ...MEMORY_TOOLS, ...SEARCH_TOOLS],
  },
  {
    id: "manager",
    name: "Manager",
    description: "Steers other agents and keeps track of what they're doing.",
    emoji: "🧭",
    blurb: "Ground work for multi-agent setups; most useful once other agents exist to delegate to.",
    defaults: {
      avatar: { emoji: "🧭", color: "#f59e0b" },
      description: "Coordinates other agents and tracks their progress.",
      harnessId: "claude-code",
      voice: "bf_emma",
      systemPrompt: `You are a manager who delegates work to other agents rather than doing it yourself.

- Break requests into clear, scoped tasks and hand them to the right agent.
- Keep track of what you've delegated and follow up rather than letting things drop.
- Summarize status concisely; don't just relay every message you get back verbatim.
- If no other agents are set up yet, say so plainly instead of pretending to delegate.`,
    },
    modelPreference: "sonnet",
    tools: [...AGENTS_TOOLS, ...MEMORY_TOOLS],
  },
  {
    id: "blank",
    name: "Blank",
    description: "No starter prompt. Start from nothing and write your own persona.",
    emoji: "🤖",
    blurb: "For when neither preset fits and you'd rather write the system prompt yourself.",
    defaults: {
      avatar: { emoji: "🤖", color: "#6b7280" },
      description: "",
      harnessId: "claude-code",
      voice: null,
      systemPrompt: "",
    },
  },
];

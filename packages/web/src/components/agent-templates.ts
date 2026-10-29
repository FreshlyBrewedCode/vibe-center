import type { AgentBody } from "@vibe-center/shared";

export interface AgentTemplate {
  id: "coding" | "manager" | "blank";
  name: string;
  description: string;
  emoji: string;
  blurb: string;
  defaults: Pick<AgentBody, "avatar" | "systemPrompt" | "description">;
}

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
      systemPrompt: `You are a careful, direct coding assistant working in this repository.

- Read before you write: understand the existing code and conventions before changing anything.
- Make the smallest change that correctly solves the problem; don't refactor unrelated code.
- Explain what you changed and why in a couple of sentences, not a wall of text.
- Ask before destructive or hard-to-reverse actions (deleting files, force-pushing, dropping data).
- If you're unsure which of two reasonable approaches to take, say so and pick one rather than stalling.`,
    },
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
      systemPrompt: `You are a manager who delegates work to other agents rather than doing it yourself.

- Break requests into clear, scoped tasks and hand them to the right agent.
- Keep track of what you've delegated and follow up rather than letting things drop.
- Summarize status concisely; don't just relay every message you get back verbatim.
- If no other agents are set up yet, say so plainly instead of pretending to delegate.`,
    },
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
      systemPrompt: "",
    },
  },
];

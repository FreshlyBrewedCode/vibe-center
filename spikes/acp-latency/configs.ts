// Benchmark configurations. Each spawns one agent process and runs the turn script.

export const PERSONA = `You are Vibe, a voice assistant on a live phone call with a software developer.
You manage their coding agents through the "voice" MCP tools: list_sessions (what the agents are doing) and dispatch_task (send an agent an instruction; returns immediately).
Everything you write is converted to speech:
- Reply in 1 to 3 short spoken sentences. Plain conversational English. No markdown, lists, headings, code or emoji.
- Before calling a tool, always first say one brief sentence such as "Let me check." or "On it."
- Use only the voice tools. Never read files, run commands or browse.
- Do not ask for confirmation for simple dispatches; just do it and confirm briefly.`;

export type AgentKind = "claude" | "opencode";

export interface Config {
  name: string;
  agent: AgentKind;
  /** claude: alias or id passed as _meta.claudeCode.options.model. opencode: config option value. */
  model: string;
  /** a = default harness prompt + persona appended; b = persona replaces system prompt (claude: also no built-in tools) */
  variant: "a" | "b";
  /** extra _meta.claudeCode.options (claude only) */
  claudeOptions?: Record<string, unknown>;
  note?: string;
}

const thinkingOff = { thinking: { type: "disabled" } };
const noToolSearch = { env: { ENABLE_TOOL_SEARCH: "false" } }; // load MCP tool schemas up front
const lean = {
  tools: [], // no built-in tools at all
  promptSuggestions: false,
  settingSources: [], // ignore ~/.claude settings, CLAUDE.md, skills, plugins
  allowedTools: ["mcp__voice__list_sessions", "mcp__voice__dispatch_task"], // no permission round trip
  ...noToolSearch,
};

export const CONFIGS: Record<string, Config> = {
  "claude-haiku-a": { name: "claude-haiku-a", agent: "claude", model: "haiku", variant: "a" },
  "claude-haiku-b": {
    name: "claude-haiku-b",
    agent: "claude",
    model: "haiku",
    variant: "b",
    claudeOptions: { ...lean, ...thinkingOff },
  },
  "claude-haiku-a-nts": {
    name: "claude-haiku-a-nts",
    agent: "claude",
    model: "haiku",
    variant: "a",
    claudeOptions: noToolSearch,
    note: "variant a, only tool search disabled",
  },
  "claude-sonnet-a": { name: "claude-sonnet-a", agent: "claude", model: "sonnet", variant: "a" },
  "claude-sonnet-b": {
    name: "claude-sonnet-b",
    agent: "claude",
    model: "sonnet",
    variant: "b",
    claudeOptions: { ...lean, ...thinkingOff },
  },
  "opencode-a": { name: "opencode-a", agent: "opencode", model: "opencode/deepseek-v4.1-flash-free", variant: "a" },
  "opencode-b": { name: "opencode-b", agent: "opencode", model: "opencode/deepseek-v4.1-flash-free", variant: "b" }, // custom "voice" agent, see bench.ts
};

export const TURNS = [
  "Hey, what's up?",
  "What are my agents doing right now?",
  "Tell the frontend agent to fix the login bug.",
  "Is the backend one still busy?",
  "Okay, ask the backend agent to also add an index on the users email column when it's done.",
  "Cool. What did you just send to the frontend agent?",
  "Got it. How many agents do I have in total?",
  "Thanks, anything else I should know?",
];

export const BARGE_IN = "Explain in detail how you would coordinate five agents working on one big refactor.";
export const AFTER_BARGE_IN = "Sorry, never mind that. Just tell me in one sentence which agent needs my input.";

CONFIGS["opencode-nemotron-b"] = {
  name: "opencode-nemotron-b",
  agent: "opencode",
  model: "opencode/nemotron-3.5-lightning-free",
  variant: "b",
  note: "fallback free model in case deepseek free tier is rate-limited",
};

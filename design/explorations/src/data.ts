// The same sample content for every direction, so they compare fairly. Mirrors the real domain
// (packages/shared/src/domain.ts) loosely: enough to render, not the real types.

export type Presence = "idle" | "thinking" | "working" | "waiting" | "in_call" | "error";

export interface Agent {
  id: string;
  name: string;
  emoji: string;
  /** Monogram fallback for directions that avoid emoji avatars. */
  initial: string;
  color: string;
  description: string;
  harness: "Claude Code" | "OpenCode";
  model: string;
  presence: Presence;
  presenceDetail: string | null;
  unread: number;
  /** Last message preview + time, for list-style layouts. */
  last: { text: string; time: string };
}

export const AGENTS: Agent[] = [
  {
    id: "robin",
    name: "Robin",
    emoji: "🐦",
    initial: "R",
    color: "#6366f1",
    description: "Coding agent on vibe-center",
    harness: "Claude Code",
    model: "claude-sonnet-5",
    presence: "waiting",
    presenceDetail: "Needs approval · git commit",
    unread: 0,
    last: { text: "Got it. Committing the header fix, then the call bar.", time: "09:17" },
  },
  {
    id: "dana",
    name: "Dana",
    emoji: "🦊",
    initial: "D",
    color: "#f97316",
    description: "Manager · steers the others",
    harness: "Claude Code",
    model: "claude-opus-5-5",
    presence: "thinking",
    presenceDetail: "Thinking",
    unread: 2,
    last: { text: "Robin is on the mobile pass. I'll check back in 10 minutes.", time: "09:16" },
  },
  {
    id: "max",
    name: "Max",
    emoji: "🛠️",
    initial: "M",
    color: "#10b981",
    description: "Infra · deploys and servers",
    harness: "OpenCode",
    model: "gpt-5.2-codex",
    presence: "working",
    presenceDetail: "Running tailscale status",
    unread: 0,
    last: { text: "Tailnet is healthy, serve entry is up on 7443.", time: "08:52" },
  },
  {
    id: "sage",
    name: "Sage",
    emoji: "🌿",
    initial: "S",
    color: "#0ea5e9",
    description: "Research · reads papers, writes notes",
    harness: "Claude Code",
    model: "claude-sonnet-5",
    presence: "idle",
    presenceDetail: null,
    unread: 1,
    last: { text: "Saved 3 memories about turn detection latency.", time: "Yesterday" },
  },
  {
    id: "juno",
    name: "Juno",
    emoji: "🪐",
    initial: "J",
    color: "#ec4899",
    description: "Writer · docs and release notes",
    harness: "OpenCode",
    model: "claude-haiku-4-5",
    presence: "error",
    presenceDetail: "OpenCode: not signed in",
    unread: 0,
    last: { text: "Error: OpenCode is not signed in.", time: "Yesterday" },
  },
];

export const ROBIN = AGENTS[0]!;
export const DANA = AGENTS[1]!;

export const PRESENCE_LABEL: Record<Presence, string> = {
  idle: "Idle",
  thinking: "Thinking",
  working: "Working",
  waiting: "Needs approval",
  in_call: "In a call",
  error: "Error",
};

export type CallState = "listening" | "thinking" | "speaking" | "waiting";

export const CALL = {
  state: "waiting" as CallState,
  elapsed: "04:12",
  replyMs: 1.4,
  speech: "GPU / GPU",
  transcript: [
    { who: "you", text: "Did the checks pass?" },
    { who: "agent", text: "They did. Lint, typecheck and tests are green. Want me to commit?" },
    { who: "you", text: "Yes, commit it." },
  ] as { who: "you" | "agent"; text: string }[],
};

export const CALL_STATE_LABEL: Record<CallState, string> = {
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
  waiting: "Waiting for approval",
};

export const CODE = `// routes/_app/agents/$agentId/index.tsx
<div className="flex min-h-0 flex-1 flex-col">
  <header className="sticky top-0 z-10 shrink-0 border-b bg-background/95">…</header>
  <MessageList … />   {/* the only thing that scrolls */}
  <Composer … />
</div>`;

export const CHECK_OUTPUT = `biome check .   ✓ 212 files, no issues
tsc --noEmit    ✓ web, server, shared
bun test        ✓ 48 pass, 0 fail (3.9s)`;

export type Msg =
  | { kind: "session"; label: string }
  | { kind: "user"; text: string; time: string; voice?: boolean }
  | { kind: "agent"; blocks: Block[]; time: string; voice?: boolean; streaming?: boolean }
  | { kind: "relay"; from: Agent; text: string; time: string }
  | { kind: "tool"; title: string; detail: string; status: "done" | "running"; output?: string; time: string }
  | { kind: "permission"; title: string; command: string; time: string };

export type Block = { kind: "p"; text: string } | { kind: "code"; code: string; lang: string };

export const MESSAGES: Msg[] = [
  { kind: "session", label: "New session · Today 09:12" },
  {
    kind: "user",
    time: "09:12",
    text: "Can you make the DM header sticky on mobile? It scrolls away with the messages when I'm on my phone.",
  },
  {
    kind: "agent",
    time: "09:12",
    blocks: [
      {
        kind: "p",
        text: "Yes. The header sits inside the same scroll container as the messages, so it moves with them. The fix is to make the message list the only element that scrolls:",
      },
      { kind: "code", lang: "tsx", code: CODE },
      {
        kind: "p",
        text: "Same treatment for the call bar, so it stays under the header during a call. Running the checks now.",
      },
    ],
  },
  {
    kind: "tool",
    time: "09:13",
    title: "Edit",
    detail: "packages/web/src/routes/_app/agents/$agentId/index.tsx",
    status: "done",
  },
  {
    kind: "tool",
    time: "09:13",
    title: "Run",
    detail: "bun run check",
    status: "done",
    output: CHECK_OUTPUT,
  },
  { kind: "user", time: "09:15", voice: true, text: "Did the checks pass?" },
  {
    kind: "agent",
    time: "09:15",
    voice: true,
    blocks: [{ kind: "p", text: "They did. Lint, typecheck and tests are green. Want me to commit?" }],
  },
  {
    kind: "relay",
    time: "09:16",
    from: DANA,
    text: "Karl wants the whole mobile pass finished today. After the header, make sure the call bar stays visible too.",
  },
  {
    kind: "agent",
    time: "09:17",
    streaming: true,
    blocks: [
      {
        kind: "p",
        text: "Got it. Committing the header fix first, then I'll pin the call bar the same way.",
      },
    ],
  },
  {
    kind: "permission",
    time: "09:17",
    title: "Run git commit",
    command: 'git commit -am "web: keep the DM header sticky on mobile"',
  },
];

export const PALETTE_HITS = [
  { agent: "Robin", snippet: "…make the message list the only scrolling element…", time: "09:12" },
  { agent: "Max", snippet: "…the tailscale serve entry on 7443 is sticky across restarts…", time: "08:52" },
];

export const TEMPLATES = [
  {
    emoji: "🛠️",
    name: "Coding agent",
    blurb: "Works in a repo: reads, edits, runs commands, asks before anything risky.",
  },
  {
    emoji: "🧭",
    name: "Manager",
    blurb: "Steers other agents: lists them, delegates, follows up, reports back to you.",
  },
  { emoji: "📄", name: "Blank", blurb: "No prompt, no tools preselected. Start from nothing." },
];

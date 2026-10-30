// Plain data about the directions (no React), shared by the app and shoot.ts.

export const SCREENS = ["desktop-dm", "desktop-call", "mobile-call", "extra"] as const;
export type Screen = (typeof SCREENS)[number];

export const DESKTOP: [number, number] = [1440, 900];
export const MOBILE: [number, number] = [390, 844];

export interface DirectionMeta {
  index: number;
  slug: string;
  name: string;
  idea: string;
  dark: boolean;
  /** What the `extra` screen shows, as a file-name suffix. */
  extra: { label: string; viewport: [number, number] };
  /** Extra captures beyond the four standard screens (e.g. a dark variant), as hash → file suffix. */
  bonus?: { hash: string; label: string; viewport: [number, number] }[];
}

export const MANIFEST: DirectionMeta[] = [
  {
    index: 1,
    slug: "workspace",
    name: "Workspace",
    dark: false,
    idea: "Slack's three-pane layout, done with care: warm neutrals, Inter, generous row rhythm, a sticky header and call strip, Slack-style pushed DM on the phone. Optimises for zero learning curve.",
    extra: { label: "palette", viewport: [1440, 900] },
    bonus: [{ hash: "workspace-dark/desktop-dm", label: "desktop-dm-dark", viewport: [1440, 900] }],
  },
  {
    index: 2,
    slug: "console",
    name: "Console",
    dark: true,
    idea: "A control room for agents: dense, dark, monospace-leaning. The sidebar is a live status board, the DM a timestamped log, tool calls are rows, and the call is a channel strip with meters. Optimises for watching several agents at once.",
    extra: { label: "mobile-board", viewport: [390, 844] },
  },
  {
    index: 3,
    slug: "messenger",
    name: "Messenger",
    dark: false,
    idea: "A phone-first calling app: bubbles, big tap targets, vivid agent colours, and a call that takes the stage as a sheet with waveform and captions. Desktop is the phone layout widened. Optimises for the iPhone and for voice.",
    extra: { label: "mobile-call-sheet", viewport: [390, 844] },
  },
  {
    index: 4,
    slug: "editorial",
    name: "Editorial",
    dark: false,
    idea: "Agents as correspondents: a paper-toned, serif-led reading layout with a narrow measure, tool calls as marginalia and a thin live ticker for the call. Almost no boxes; typography carries the hierarchy. Optimises for reading long replies calmly.",
    extra: { label: "new-agent", viewport: [1440, 900] },
  },
  {
    index: 5,
    slug: "pulse",
    name: "Pulse",
    dark: true,
    idea: "A bold, dark, voice-forward app: an icon rail and avatar strip instead of a sidebar, the call as a capsule that expands from the top, agent activity as glowing rings. Optimises for presence at a glance and one-thumb use.",
    extra: { label: "mobile-home", viewport: [390, 844] },
  },
];

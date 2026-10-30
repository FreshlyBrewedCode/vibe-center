// Plain data about the directions (no React), shared by the app and shoot.ts.

export const SCREENS = ["desktop-dm", "desktop-call", "mobile-call", "extra"] as const;
export type Screen = (typeof SCREENS)[number];

export const DESKTOP: [number, number] = [1440, 900];
export const MOBILE: [number, number] = [390, 844];

/** One capture: which screen key to render, the file-name suffix, the viewport and the colour scheme. */
export interface Shot {
  screen: string;
  label: string;
  viewport: [number, number];
  dark: boolean;
}

export interface DirectionMeta {
  index: number | string;
  slug: string;
  /** File-name stem for the screenshots when it should differ from the slug (`<index>-<file>-<screen>.png`). */
  file?: string;
  name: string;
  idea: string;
  dark: boolean;
  /** What the `extra` screen shows, as a file-name suffix. */
  extra: { label: string; viewport: [number, number] };
  /** Extra captures beyond the four standard screens (e.g. a dark variant), as hash → file suffix. */
  bonus?: { hash: string; label: string; viewport: [number, number] }[];
  /** Round 2+: an explicit list of captures instead of the four standard screens. */
  shots?: Shot[];
}

/** The round-2 screen set: desktop DM (rail collapsed / expanded), desktop call, mobile list, mobile DM
 *  in a call, mobile call sheet, desktop DM in light, ⌘K palette. */
export function round2Shots(dark = true): Shot[] {
  return [
    { screen: "desktop-dm", label: "desktop-dm", viewport: DESKTOP, dark },
    { screen: "desktop-dm-expanded", label: "desktop-dm-expanded", viewport: DESKTOP, dark },
    { screen: "desktop-call", label: "desktop-call", viewport: DESKTOP, dark },
    { screen: "mobile-agents", label: "mobile-agents", viewport: MOBILE, dark },
    { screen: "mobile-call", label: "mobile-call", viewport: MOBILE, dark },
    { screen: "mobile-call-sheet", label: "mobile-call-sheet", viewport: MOBILE, dark },
    { screen: "desktop-dm-light", label: "desktop-dm-light", viewport: DESKTOP, dark: false },
    { screen: "palette", label: "palette", viewport: DESKTOP, dark },
  ];
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
  {
    index: 6,
    slug: "nocturne",
    name: "Nocturne",
    dark: true,
    idea: "Round 2: Messenger's structure and calling model (floating call card, full-screen call sheet, pushed DMs on the phone) with Pulse's collapsible icon-rail sidebar, in a restrained dark-first language: cool graphite surfaces, hairlines, one quiet indigo accent, bubbles for short turns and full-width blocks for long output.",
    extra: { label: "mobile-call-sheet", viewport: MOBILE },
    shots: round2Shots(),
  },
  {
    index: "6b",
    slug: "nocturne-b",
    file: "nocturne",
    name: "Nocturne · Ash",
    dark: true,
    idea: "Same direction, second variant: warm charcoal surfaces with an ivory (monochrome) accent, and no bubbles at all — every turn is a row with a name line, Slack-style, so long and short replies read the same way.",
    extra: { label: "mobile-call-sheet", viewport: MOBILE },
    shots: round2Shots(),
  },
];

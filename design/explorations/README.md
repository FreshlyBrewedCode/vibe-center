# Vibe Center — UI design explorations

Round 1: five directions for the redesign, rendered as React + Tailwind mocks with the same sample content, so
they compare fairly. Round 2 (below, [§6 Nocturne](#6-nocturne-round-2)): one refined direction that blends
Messenger and Pulse, in two close variants. Pick one; the next round redesigns the app in that direction.
Nothing here touches the app.

- **Gallery**: open [`gallery.html`](gallery.html) for all screenshots side by side.
- **Live mocks**: `bun run dev` in this folder (port 5199), then `#/<slug>/<screen>` or the index page.
- **Re-render**: `bun shoot.ts [slug…]` writes `screenshots/<n>-<slug>-<screen>.png` with the repo's nix
  chromium (round 2: `bun shoot.ts nocturne nocturne-b`). Fonts: Inter, JetBrains Mono, Fraunces and Noto Color Emoji via a fontconfig file
  (`VC_FONTCONFIG`, default `/tmp/vc-fonts/conf/fonts.conf`; `nix build nixpkgs#{inter,jetbrains-mono,fraunces,noto-fonts-color-emoji}`).
  The HTML also loads the same families from Google Fonts for viewing on a Mac.

Layout: `src/data.ts` (shared sample data), `src/ui.tsx` (avatar, code, phone frame), `src/manifest.ts`
(names, viewports), one folder per direction (`index.tsx` + `theme.css`, each scoped to a root class and
reading the same semantic tokens: `--bg`, `--fg`, `--muted`, `--line`, `--accent`, presence colours, …). A
winner ports directly: its `theme.css` becomes the app's token set, its components replace the shadcn
defaults.

## The content every direction shows

Five agents: Robin (coding, needs approval), Dana (manager, thinking, 2 unread), Max (infra, working), Sage
(research, idle, 1 unread), Juno (writer, OpenCode not signed in). The DM with Robin: a session divider, a
user request, a reply with a code block, two tool calls (one with output), a spoken exchange, a relay from Dana
to Robin, a streaming reply, a pending approval card, the composer. The call screens show the same DM during a
call in the "waiting for approval" state with a 04:12 timer, mute, hang up and the live transcript.

---

## 1. Workspace

**Idea.** Slack's three-pane layout, done well instead of left at shadcn defaults. A deep-plum sidebar gives the
app an identity; the DM is calm, warm-neutral and typographically tidy (Inter, 14.5px body, 36px avatars,
clear name/time/badge line). Tool calls are compact bordered rows, output expands in place, the approval card is
amber with a real primary button. The call is a strip under the header with state, timer, latency, mute and
hang up, and the last two transcript lines. On the phone the DM is a pushed screen: back chevron, sticky header,
sticky call strip, composer at the bottom. Shown in light and dark.

**Optimises for** zero learning curve and long-term comfort: it looks like the tools people already use.

**Strengths.** Nothing to learn; every existing screen (settings, memories, MCP, agent editor) has an obvious
home; the details panel is a natural place for session/tools/voice info; dark mode is a token swap; the approval
card and call strip are the least ambiguous of the five.

**Trade-offs.** Least distinctive; a tinted sidebar is still a sidebar. On mobile the sticky header plus call
strip plus transcript take ~170px, so the transcript should collapse to one line on the phone. The call stays a
"bar", so a voice-first session never feels like a call.

**Screens.** `screenshots/1-workspace-desktop-dm.png` (details panel open), `1-workspace-desktop-call.png`,
`1-workspace-mobile-call.png`, `1-workspace-palette.png` (⌘K), `1-workspace-desktop-dm-dark.png`.

## 2. Console

**Idea.** A control room. The sidebar is a status board (counts of busy/waiting/error, each agent's current
activity in its presence colour, an activity sparkline, the harness as a tag). The DM is a log: a timestamp
gutter, a coloured sender column, text rows; tool calls are one-line rows with duration; the approval is a
highlighted row with keyboard hints. A right-hand inspector shows session, agent, tools and relays. The call is a
channel strip: state, timer, input/output meters, STT/TTS backends, with transcript lines underneath. Dark,
graphite, JetBrains Mono for everything that is data.

**Optimises for** running several agents at once and seeing what each is doing without opening it.

**Strengths.** The densest view of agent activity; relays and tool calls read as events, which matches the
product's manager-agent future; keyboard-first by construction; the mobile board with a cross-agent activity
feed is a genuinely useful phone screen.

**Trade-offs.** Cold for a product whose pitch is "talk to a colleague"; dense mono UI is tiring on a phone
(the mobile call strip had to drop to icon-only); long markdown replies look like log lines; light theme would
need a second design pass.

**Screens.** `screenshots/2-console-desktop-dm.png`, `2-console-desktop-call.png`,
`2-console-mobile-call.png`, `2-console-mobile-board.png` (mobile status board + activity feed).

## 3. Messenger

**Idea.** Treat it as a calling app first. The agent list is a Messages-style list (big round avatars, preview,
time, unread dot); the DM uses bubbles (user in accent, agent in grey, Dana's relay tinted in her colour), tool
calls are centred "activity" pills, the approval is an app-card bubble with two large buttons. The call is a
first-class object: on desktop a FaceTime-style picture-in-picture card over the thread; on the phone a green
system-style call strip under the sticky header, and a full-screen call sheet (big avatar, state pill, captions)
with the pending approval rendered inside the call itself. Light, iOS-grouped greys, 15–16px type.

**Optimises for** the iPhone and for voice.

**Strengths.** Best thumb ergonomics of the five; the call sheet makes "waiting for approval" during a call a
one-tap decision; code blocks as dark bubbles stay legible; every pattern is one the user's phone already
teaches.

**Trade-offs.** Bubbles waste width on a 1440px desktop and fight long code replies; the "Agents / Calls /
Memories" tabs assume a call history page that does not exist yet; presence detail (current tool) has nowhere
to go but the preview line; a dark theme is routine but the green call strip needs tuning.

**Screens.** `screenshots/3-messenger-desktop-dm.png`, `3-messenger-desktop-call.png` (PiP call card),
`3-messenger-mobile-call.png`, `3-messenger-mobile-call-sheet.png` (full-screen call).

## 4. Editorial

**Idea.** Agents as correspondents, the DM as a transcript you read. Paper background, Fraunces for body and
headings, small-caps Inter labels for metadata, hairlines instead of boxes. Each turn has a 600px measure; on
desktop the tool calls sit as marginalia in a right-hand column beside the turn that produced them. The approval
is a red-ochre rule with two text-button actions. The call is a thin "LIVE · 04:12 · Waiting for approval"
ticker under the masthead with the last spoken line in italics. The extra screen is agent creation ("Who are we
hiring?") with templates as paper slips.

**Optimises for** reading long replies calmly and giving the product a voice of its own.

**Strengths.** Immediately distinctive; long markdown answers read beautifully; marginalia keep tool noise out
of the text; the masthead makes the agent's name and status the most prominent thing on screen, which is what a
sticky mobile header should do.

**Trade-offs.** Serif body at 17px costs vertical space on the phone; marginalia collapse to inline notes on
mobile, losing the idea; a transcript metaphor undersells the real-time parts (streaming, calls); code and
terminal output will always look foreign on paper; dark mode is possible (ink on slate) but not shown.

**Screens.** `screenshots/4-editorial-desktop-dm.png`, `4-editorial-desktop-call.png`,
`4-editorial-mobile-call.png`, `4-editorial-new-agent.png`.

## 5. Pulse

**Idea.** A bold, dark, voice-forward app. The sidebar collapses to an icon rail of 44px avatars with glowing
presence rings (amber = needs approval, blue = thinking, green = working, red = error) and unread badges. The DM
header is a floating glass capsule; in a call it expands into a call island (avatar with ring, state, timer,
mute, hang up, last transcript lines) and content scrolls underneath with a fade. User messages are glass
bubbles, agent text is plain, tool calls are mono chips, the approval card has a gradient border and a gradient
Allow. One violet-to-coral gradient marks every primary action, including the big Call button. The extra screen
is the mobile home: a grid of agent tiles with rings and quick call/message actions.

**Optimises for** presence at a glance and one-thumb use; it wants to be an app, not a web tool.

**Strengths.** Presence is readable from across the room; the island is a natural sticky header for mobile and
already doubles as the call UI; the gradient and glass give a strong identity with very few components.

**Trade-offs.** The island hides ~150px of content and needs the fade trick; glass and glow are expensive to
keep consistent across the long tail of screens (settings, MCP forms, memories); the icon rail loses names and
status text, so hover/long-press becomes essential; a light theme is not natural for this direction.

**Screens.** `screenshots/5-pulse-desktop-dm.png`, `5-pulse-desktop-call.png`, `5-pulse-mobile-call.png`,
`5-pulse-mobile-home.png`.

---

## Recommendation

**Workspace as the base, with Messenger's phone layer and Pulse's presence rings.**

Why Workspace: the product's own spec says "Slack-like layout" and lists settings, memories, MCP servers, tool
toggles, an agent editor and a details panel. Those are forms and lists, and the three-pane layout gives all of
them an obvious home; Console, Editorial and Pulse each make the long tail harder. Workspace also fixes the
actual complaints (generic shadcn look, non-sticky header and call bar, cramped phone) with the least risk, and
its token set is a drop-in for the existing `index.css`.

What to borrow: on the phone, the DM should behave like Messenger (pushed screen with a back chevron, sticky
header, a compact green call strip, bottom-anchored composer, big tap targets) and the call should be able to
expand into Messenger's full-screen call sheet with the approval card inside it; that is the one place where a
bar is not enough. In the sidebar, Pulse's glowing presence ring on the avatar reads better than a 10px dot and
costs nothing.

If the user wants the app to feel like a product rather than a tool, **Pulse** is the bold alternative worth
considering; **Messenger** is the right pick if the phone is the primary device after all.

---

## 6. Nocturne (round 2)

**Idea.** Messenger's structure and calling model with Pulse's sidebar, in a restrained, dark-first language.
The sidebar is Pulse's icon rail (64px: avatars with a presence ring, unread badges, a hover tooltip with name
and status) that expands to a 272px list (name, status line in the presence colour or the last message when
idle, time, unread pill, Memories / MCP / Settings and the signed-in user at the bottom). The DM keeps
Messenger's shape: sticky header, bottom-anchored composer, the call as a floating card on desktop and a
full-screen sheet on the phone. The visual language is deep neutral surfaces, 1px hairlines, one quiet accent,
Inter, and glow only on live states (a needs-approval, in-call or error ring; a pulse on thinking/working).
Nothing is a gradient.

**The DM at 1440px.** Two renderings of the same turn model, so the user can pick:

- **6 — bubbles, hybrid.** Short turns are bubbles (the user's in the soft accent on the right, the agent's on
  the card surface with a hairline on the left, Dana's relay the same with a "relay to Robin" chip). A long
  agent reply (more than one block, or any code) drops the bubble and becomes a full-width block under a name
  line: prose at a 72ch measure, code full width on the panel surface. Consecutive tool calls fold into one
  activity card ("Edited …", "Ran bun run check ✓ 48 tests pass") indented to the text column. The approval is
  a 520px card with an amber hairline, the command on the base surface, a solid-accent Allow and a ghost
  Deny, plus ⏎ / esc hints.
- **6b — rows, no bubbles.** Every turn is a row with a name line (You / Robin / Dana), Slack-style, so long
  and short replies read the same; the relay gets a 2px rule in Dana's colour. Same tool card and approval.

**Calling.** Desktop: a 320px card floats top-right over the thread (elevation 3): avatar with the call ring
(amber when waiting for approval), name, timer, state, the last two transcript lines, and — new in this round
— the pending approval itself with Allow / Deny inside the card, so a voice session never needs the thread;
mute, speaker, hide and hang up below. The header shows "● In a call · 04:12" and hides its Call button.
Phone: the DM has a sticky header (back chevron, avatar with ring, name, state) and a compact call strip under
it (state, timer, "Tap to open the call", mute, hang up); tapping it opens the full-screen call sheet: a
faint radial tint in the agent's colour, 112px avatar with the glowing ring, name, state pill, transcript, the
approval card, and the four 64px controls. The composer stays at the bottom with safe-area padding.

**Tokens** (`6-nocturne/theme.css`; 6b overrides the surfaces and accent, `.light` swaps the set):

| token                                                 | 6 (dark)                                                      | 6b (dark)                                                     | 6 light                                                           |
| ----------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------- |
| `--bg` / `--panel` / `--card` / `--muted`             | `#0e0f12` / `#121317` / `#17181d` / `#1f2026` (cool graphite) | `#121110` / `#161514` / `#1c1b19` / `#252321` (warm charcoal) | `#fbfbfc` / `#f3f3f6` / `#fff` / `#ebebf0`                        |
| `--fg` / `--muted-fg`                                 | `#e9eaef` / `#878b98`                                         | `#ece8e1` / `#8f8a82`                                         | `#15161b` / `#6a6e7c`                                             |
| `--line` / `--line-strong`                            | white 7% / 13%                                                | white 7% / 13%                                                | black 8% / 14%                                                    |
| `--accent` / `--accent-fg` / `--accent-soft`          | `#8f97ff` / `#0b0c16` / accent 22% on card                    | `#ece8e1` (ivory) / `#141311` / `#2a2825`                     | `#5b64dc` / `#fff` / `#e8eaff`                                    |
| presence: thinking / working / waiting / call / error | `#6ea8fe` / `#45c98a` / `#f0b24a` / `#45c98a` / `#f26d66`     | same                                                          | darker: `#2f6fdb` / `#1f9d63` / `#c7811a` / `#1f9d63` / `#d9433b` |

- **Type**: Inter; desktop body 14.5px / 1.55, phone body 16px; name 13px semibold; meta 11.5–12px; section
  labels 11px uppercase, 0.08em tracking; mono (JetBrains Mono) 12.5px desktop, 11.5px phone; display 28px on
  the phone (call sheet name, list title). Tabular numerals for times.
- **Radii**: 5 (kbd), 8 (code inside cards), 10 (inputs, buttons, chips), 12 (tool card, code block), 14
  (approval, call strip), 16 (composer, palette), 18 (bubbles, 6px on the tail corner), 20 (call card), full
  (avatars, pills).
- **Elevation**: 0 = `--bg` (thread), 1 = `--panel` (sidebar, code), 2 = `--card` + 1px `--line` (bubbles,
  tool card, approval, composer), 3 = `--card` + `--line-strong` + `--elev` (an inset 1px top highlight, a
  20/50px shadow and a 2/8px shadow: call card, palette, tooltip). Light mode uses the same levels with a
  softer shadow.
- **Presence ring**: 2px ring, 4px outside the avatar, with a 2px gap in the surface colour; glow
  (`0 0 14px` at 45%) only on needs-approval, in-call and error; thinking/working pulse at 1.6s; idle has no
  ring.
- **Motion**: 160ms ease-out for hover/press; sidebar collapse/expand 220ms (width, labels fade in after
  80ms); call card appears with a 240ms scale-from-0.96 + fade and slides into the header strip on the
  phone; the call sheet is a bottom sheet (320ms spring); the streaming caret blinks at 1s; all of it off
  under `prefers-reduced-motion`.

**6 vs 6b.** Same components and content; two axes differ, and they can be recombined in round 3:

|               | 6                                                                  | 6b                                                              |
| ------------- | ------------------------------------------------------------------ | --------------------------------------------------------------- |
| surfaces      | cool graphite (blue-black)                                         | warm charcoal                                                   |
| accent        | quiet indigo `#8f97ff` on primary buttons, user bubbles, badges    | ivory (monochrome): white-ish buttons and badges, no hue at all |
| desktop turns | hybrid: bubbles for short turns, full-width blocks for long output | rows with a name line, no bubbles anywhere                      |
| feel          | a messenger that knows how to show code                            | a workspace that happens to be a chat                           |

**Sidebar behaviour.** The rail is the default on desktop; ⌘\ (and the panel icon at the bottom of the rail /
top of the list) toggles it, and the choice is remembered. Collapsed: 36px avatars in a 48px hit area, the
active one on a `--muted` tile with a 3px bar at the window edge; unread count as a badge on the avatar; hover
(or focus) shows a tooltip with name, status and unread. Expanded: the same order, plus name, status line,
time and badge; the bottom rows (Memories, MCP servers, Settings) and the user row gain labels. On the phone
there is no sidebar: the agent list is its own screen with a tab bar (Agents, Memories, Tools, Settings) and
DMs push over it.

**Trade-offs.** The call card covers ~320×350px of the thread on a laptop, so it needs a "hide" control (it
has one) and should remember its corner. The hybrid rule in 6 (bubble vs. block) must be deterministic and
explained once, or it looks random: "one paragraph and nothing else = bubble". 6b's ivory accent means
"primary" and "selected" are both near-white, which is sleek but gives up colour as a signal for the one
button you must press. Both keep the amber approval ring as the only strong colour in the thread on purpose.

**Screens.** `screenshots/6-nocturne-desktop-dm.png` (rail collapsed, Dana tooltip),
`6-nocturne-desktop-dm-expanded.png`, `6-nocturne-desktop-call.png` (floating call card with the approval),
`6-nocturne-mobile-agents.png`, `6-nocturne-mobile-call.png` (sticky header + call strip),
`6-nocturne-mobile-call-sheet.png`, `6-nocturne-desktop-dm-light.png`, `6-nocturne-palette.png` (⌘K); the same
eight as `6b-nocturne-*.png`.

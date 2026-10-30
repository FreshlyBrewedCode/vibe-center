# Vibe Center — UI design explorations

Five directions for the redesign, rendered as React + Tailwind mocks with the same sample content, so they
compare fairly. Pick one; the next round redesigns the app in that direction. Nothing here touches the app.

- **Gallery**: open [`gallery.html`](gallery.html) for all screenshots side by side.
- **Live mocks**: `bun run dev` in this folder (port 5199), then `#/<slug>/<screen>` or the index page.
- **Re-render**: `bun shoot.ts [slug…]` writes `screenshots/<n>-<slug>-<screen>.png` with the repo's nix
  chromium. Fonts: Inter, JetBrains Mono, Fraunces and Noto Color Emoji via a fontconfig file
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

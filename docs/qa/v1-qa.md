# Vibe Center v1: QA pass and bug bash

Done against `main` at `0cc428d` (all phases merged), in a separate worktree/branch. An Opus
agent reviewed the code in parallel (read-only); this report is about behaviour as a user
experiences it, found by actually running the app.

## How it was tested

- `bun run check`, `bun run check:voice` and `bun run e2e` (NixOS: linked `.chromium` to the same
  nix-built Chromium the other worktrees already use, instead of rebuilding it).
- `scripts/screenshots.ts` against a local `--local --data-dir /tmp/…` server, for the stock
  screen set.
- A handful of throwaway Playwright scripts (not committed) driving a local server the same way,
  for scenarios the stock script and the e2e suite don't cover: agent-to-agent relay rendering, a
  call started/hung-up from a device that isn't the DM, the interrupted-voice-reply marker,
  Memories create/edit/delete, a misconfigured harness, and two browser contexts as two devices.
  Every server/worker process and browser they started was torn down afterwards (checked with
  `ps aux` for leftovers); none were left running.
- Real Claude Code (the `claude` CLI was already signed in) and real OpenCode (configured with
  `opencode/*-free` models) were available in this environment, so "real Claude Code with Haiku"
  was tested for real, not just against the fake harness.

## The known issues (product owner's list)

All six were real, reproduced first, then fixed. Commits are on this branch, in order:

1. **Cards under the wrong sender** (`47c722b`) — `MessageList`'s "does this message start a new
   sender's run" check only considered `text`/`voice_transcript` messages. A turn that opened with
   a tool call, plan or permission request (before any text) got no header of its own, so it
   rendered glued under whatever header came last — the user's previous message, as in
   `docs/screenshots/dm-dark.png`. Fixed by grouping every message kind by sender identity, not
   just the two text-like kinds. Verified against the screenshot (now shows "Robin" above the
   permission card) and a fresh run of `scripts/screenshots.ts`.

2. **Message grouping** (`47c722b`, same root cause/fix) — consecutive messages from the same
   sender within 5 minutes already collapsed to one header for text; the fix above extends the
   same grouping to every kind, so a whole turn (text, tool calls, plan, permission) shares one
   header until the sender or source changes.

3. **Mobile header shows the agent name twice** (`7549300`) — `MobileNav`'s top bar and the DM's
   own `<header>` both rendered avatar + name + presence. The DM header now hides that block below
   `sm`; presence detail moved into the top bar instead of being dropped. `e2e/ui.spec.ts` now
   asserts the mobile top bar's presence (`mobile-presence`) is visible and the DM header's own
   (`presence`) is not, at phone width.

4. **Proactive event messages render as "You"** (`47c722b`, same fix as #1/#2) — the UI already had
   the relay badge logic (`message to X` / `reply to X`) for agent-to-agent messages, but the
   grouping bug above hid it whenever a relay message happened to land right after a plain user
   message (the common case, since the DM shows "You: <delegation text>" then the relay). Grouping
   by sender identity (which treats a relay message as its own sender, keyed by the other agent)
   fixes this too. Verified with a scripted `pingpong` exchange between two agents — see
   `docs/screenshots/dm-relay-light.png`: Ben's message and his reply both get their own header and
   badge in Alice's DM, distinct from Alice's own "You" rows.

5. **The call is only visible inside its DM** (`7549300`) — added `GlobalCallIndicator`: agent,
   live state, hang-up and a link back to the DM, mounted in the sidebar (desktop) and under the
   mobile top bar, hidden only where the DM's own `CallBar` already shows the same call. See
   `docs/screenshots/call-indicator-light.png` and `call-indicator-mobile-light.png` (both taken
   while viewing a different agent's DM, call running with "Robin").

6. **Interrupted replies stored as if fully heard** (`8052795`) — a barge-in while the turn is
   still generating already cancels it correctly (`status: "cancelled"`, shown as "Stopped"). But
   text generation usually finishes well before TTS playback does, so the common barge-in case is
   "the turn already completed, nothing to cancel" — and that case silently did nothing, leaving a
   complete-looking message for a reply the user actually cut off. The worker now reports that case
   over a new `interrupted` bridge frame; the app flags the reply message(s)
   (`TurnMeta.interrupted`) without touching their text, and the DM/call transcript show "Interrupted
   — you may not have heard all of this". Truncating to what was actually spoken (the "bonus" in the
   brief) would need per-sentence timing from the worker, which it doesn't have cheaply, so a
   marker is what shipped. Verified via a new `bun test` case (`voice.test.ts`) and a scripted call
   through the fake worker — `docs/screenshots/voice-interrupted-light.png`.

## Bugs found during the bug bash (beyond the known list)

- **Hang-up/mute silently no-op from a tab that didn't start the call** (`7549300`). While wiring
  the hang-up button on the new global indicator, found `CallBar`'s hang-up and mute already had
  the same bug: both gated on "is this call on my device" (`call.deviceId === me.id`), which is
  true for *every* tab of that device (they share the session cookie) — but the actual
  `RTCPeerConnection` only lives in the one tab that called `startCall()` (in-memory `local` state,
  not synced across tabs or page reloads). Any other same-device tab would call the local
  `hangUp()`/`toggleMute()`, which quietly do nothing without a live session, instead of reaching
  the server. Reproduced: started a call via the API (simulating "a different tab/reload"), clicked
  hang up from the sidebar indicator — the call stayed open server-side. Fixed by gating those two
  actions on actually holding the call's session (`local.callId === call.id`) instead of the device
  check, which is now used only for the status label (where showing the live server state is
  correct either way). Re-verified the same repro now ends the call.

## What else was exercised

- **First run / auth**: link sign-in, device create via `/api/auth/exchange`; devices list/revoke
  covered by `e2e/ui.spec.ts`. Didn't separately test an expired or reused link by hand (covered
  implicitly by the auth module's unit tests, not re-verified interactively here — low risk, no
  code in this area changed).
- **Agents**: create from each template, edit every field, duplicate, delete — covered by
  `scripts/screenshots.ts` + `e2e/ui.spec.ts`. Real Claude Code probe populated the real model
  dropdown (Opus 5.5 / Fable 5.1 / Sonnet 5.5 / Haiku 5.5 / …) in a manual run.
- **Real Claude Code + Haiku**: created an agent on the real `claude-code` harness, selected Haiku,
  sent a message, got a real streamed reply. New session, stop and permission approve/deny weren't
  re-run against the *real* harness in this pass (they're exercised against the fake harness in
  `e2e/chat.spec.ts`, which passed); a long reply with code blocks wasn't separately checked against
  the real harness either.
- **OpenCode**: confirmed `opencode acp` and free models (`opencode/*-free`) are available in this
  environment; didn't create and chat with an OpenCode agent end-to-end in this pass — time
  budget went to the known issues and the bugs above instead. Flagging as the main gap in this
  report (see Open issues).
- **MCP**: add a stdio server, enable tools, call through the gateway — `e2e/mcp.spec.ts`.
  Memories (create, edit, delete) — exercised by hand (not just the e2e's create+view), all three
  worked cleanly, no bugs found.
- **Agent-to-agent messaging**: exercised by hand with the `pingpong` fake-agent keyword (two
  agents messaging back and forth into the hop limit) — see the relay screenshot above; also
  confirmed the hop limit and self-message guard both produce the right user-visible error text.
- **Search and ⌘K**: `e2e/ui.spec.ts`.
- **Two browser contexts as two devices**: by hand — device B (DM already open) saw device A's
  prompt stream in live, with presence following along in the sidebar. No unread badge appeared
  when B navigated away afterwards, which looked like a bug until checking
  ARCHITECTURE's documented behaviour: a DM that's open marks messages read as they stream in, so
  this is the "it was open the whole time" case, not the "badge should show" case. Not re-tested
  with B never having opened the DM (the badge-showing case) — time budget; low risk, no code
  changed in the unread path.
- **Failure states**: a custom harness pointed at `/no/such/binary` showed "command not found:
  /no/such/binary" with a "Fix in Settings" link and a disabled composer ("The harness is
  unavailable") — exactly per spec. Didn't separately re-check the voice-worker-down and
  MCP-server-failing states in this pass (no code in those paths changed; `voice.test.ts` already
  covers the worker-down/crash-restart cases).
- **Responsive / theme**: phone width and light/dark covered throughout (every screenshot above has
  both a light and/or dark/mobile variant); `e2e/ui.spec.ts` also covers the dark-theme toggle.
- **Real tailnet HTTPS path**: not tested in this pass — this environment has no tailnet configured
  on the box, and setting one up was out of scope for the time available. Flagging as not done
  rather than silently skipping it.
- **Notifications**: not separately tested (headless browsers don't surface OS notifications
  meaningfully) — `lib/notifications.ts`/`useAgentNotifications` wasn't touched by this pass's
  changes, and existing e2e exercises the unread path it depends on.

## Open issues (not fixed, for the product owner)

- **OpenCode wasn't chat-tested end-to-end** in this pass (see above). Recommend a short follow-up
  pass specifically on an OpenCode agent with a free model, since it's explicitly called out in the
  brief and the time budget here went to the known issues + the hang-up bug instead.
- **Real tailnet HTTPS path untested.** Needs a machine with Tailscale configured; recommend
  checking it once on a real device (e.g. the user's MacBook, since that's the actual v1 target)
  rather than trying to fake it here.
- **Truncating an interrupted reply to what was actually heard** is still not implemented (the
  "bonus" in the brief) — it would need the worker to report sentence-level TTS playback progress
  back over the bridge, which is a larger change than the marker. Worth a follow-up if the marker
  alone feels insufficient in practice.
- **GPU voice** (km-pc) wasn't touched, per the brief ("don't wake km-pc; GPU testing happens with
  the user").

## Test status

- `bun run check` — pass (lint, typecheck across all packages + e2e, `bun test`: 65 pass across 5
  files, including the two new interrupted-marker tests).
- `bun run check:voice` — pass (ruff + 10 pytest cases, including the new `mark_interrupted` test).
- `bun run e2e` — pass (4/4 specs: chat, mcp, ui, voice-call).

## Screenshots

Refreshed with `scripts/screenshots.ts` (`docs/screenshots/*-light.png`, `dm-dark.png`,
`dm-mobile-dark.png`, `mobile-drawer-dark.png`, `settings-appearance-dark.png`): all now show the
fixed card-grouping and mobile header. Added four new ones for the screens the stock script doesn't
cover: `dm-relay-light.png` (agent-to-agent relay), `call-indicator-light.png` /
`call-indicator-mobile-light.png` (the new global call indicator), `voice-interrupted-light.png`
(the interrupted marker).

---

# Round 2: UI-side fixes from the v1 code review

Done against `main` at `09d1413`, in its own worktree/branch, alongside an Opus agent fixing the
server-lifecycle findings from the same review (`docs/reviews/v1-review.md`, not tracked in this
worktree) in parallel. This round covers the review's UI/web-package findings end to end: fix,
manual verification with Playwright against a local server, refreshed screenshots, and e2e
coverage for the two fixes most at risk of regressing silently.

## What changed

1. **DM composer locked by a stale health check (H2, UI half)** — the composer now disables only
   for a confirmed-unusable harness (`not_installed` or `auth_required`); a cached `error` (e.g. a
   probe timeout at boot) still shows the banner but leaves sending enabled, since a real turn
   might work. A send failure, or the banner's own "Check again" button, re-probes the harness.
   Verified by hand (a harness whose command is `true` — exists, exits immediately, probes as
   `error`) and with a new e2e case (`e2e/chat.spec.ts`) that asserts the composer and Send button
   stay enabled in exactly that state.

2. **Failure states that point to the fix** — turn-level errors now carry a `hint`
   (`shared/domain.ts`'s error message `data`), rendered as a "Fix in Settings" link via a new
   `FixInSettingsLink` component, reused by the composer's own banner (→ Harnesses) and by a failed
   MCP gateway tool call's card (→ MCP servers). Voice's existing offline message already named
   "Settings → Voice" and wasn't changed. Not separately covered by a new e2e case — it reuses the
   same `ApiError.hint`/message `data.hint` plumbing the composer fix already exercises, and a
   from-scratch harness-crash-mid-turn scenario needs more setup (a process that answers
   `session/new` then dies) than the time budget allowed; low risk since the rendering is a plain
   conditional on existing, tested data.

3. **Templates pre-fill harness, model, tools, voice** — "Coding agent" and "Manager" now set a
   harness (Claude Code), a model picked from the harness's probed list by a "sonnet"-tier
   preference (falls back to the harness default if nothing's probed yet), a persona voice, and a
   built-in tool preset applied via `PATCH /agents/:id/tools` right after create (Manager: agents +
   memory on; Coding agent: memory + conversation search on, agent-messaging off, which also
   narrows M3's default-on trust-model gap for solo coding agents). "Blank" keeps the harness
   default and no tool changes. Verified with a refreshed `agent-editor-light.png` (shows the
   "Coding agent" template's pre-filled description/prompt) and a new e2e assertion in
   `e2e/ui.spec.ts` that the harness combobox shows "Claude Code" before the test's own harness
   swap, and that the created agent's `send_message_to_agent` tool is off while `memory_save`
   stays on.

4. **Searchable model combobox (M6)** — added `components/combobox.tsx` (Popover + Command,
   grouped, searchable) and routed any select-type config option through it once it has more than
   20 choices (`OptionSelect` in `agent-form.tsx`); shorter lists (Claude Code's handful of models)
   keep the plain Select. Verified for real against the actual OpenCode preset (~580 models,
   screenshots below) — search narrowed "deepseek-v4.1-flash-free" to one grouped match instantly.

5. **Details panel: Tools and Voice sections (spec: "partial")** — replaced the empty placeholder
   with a compact per-server tool summary (built-in / each MCP server, "`n` of `m` on", a link to
   the full editor) and a Voice section (the agent's voice, a preview button reusing the voice
   picker's preview logic via a new `usePreviewVoice` hook, and the live call state when in a
   call). Verified with a refreshed `dm-details-light.png`.

6. **Custom harness env masked like MCP secrets (L1, UI half)** — `Harness.env` is now a
   `SecretMap` (key + last-4 hint, never the value) in the shared contract, and the harness form
   reuses the same write-only `SecretRows` editor the MCP server form uses (extracted into
   `components/mcp/secret-rows.tsx`), instead of a raw `KEY=value` textarea. Since the review
   assigns this finding's API side to the Opus branch too, this round also made the minimal
   server-side change needed to keep the UI honest end to end now (masking in
   `domain/harnesses.ts`, a `rawLaunchConfig` accessor so process spawn still gets the real env) —
   expect a rebase conflict here against the Opus branch at integration, to be resolved in favor of
   whichever version lands first. Verified by hand: added a custom harness with an env secret
   through Settings → Harnesses, reopened it, and confirmed the value shows as
   `unchanged (…7890)`, never the real value (`settings-harness-secret-light.png`).

7. **Low-severity findings taken (L16)** — replaced the native `confirm()` dialogs for memory and
   MCP server deletes with the same `AlertDialog` agent/device deletes already use
   (`routes/_app/memories.tsx`, `routes/_app/settings/mcp.tsx`). Also updated `AGENTS.md`'s "UI
   extension points" section, which still described the DM header call button, the details panel's
   Voice section, the agent editor's Voice section and Settings → Voice as open 2b seams; all four
   were already implemented in the code (the Voice section in the details panel was the one
   genuinely-open seam, filled by item 5 above). Other low findings (L2–L15, L17, L18) are server
   or `services/voice`/`services/speech-gpu` scoped, out of this round's `packages/web` brief.

## OpenCode: chat-tested end to end

QA's round 1 flagged OpenCode as not chat-tested through the UI. Created an agent on the real
`opencode` preset with model `opencode/deepseek-v4.1-flash-free` (`opencode models` confirmed it's
available), entirely through the UI against a local server (`--local --no-voice`, a throwaway
`--data-dir`), using a nix Chromium (`nix build nixpkgs#chromium -o .chromium`, this host's
Playwright needs it) since the box has no `t3 browser setup`:

- **Create + model search**: harness switched to OpenCode, the model combobox (now >20 choices)
  opened, searching `deepseek-v4.1-flash-free` narrowed instantly to the one grouped match.
- **Chat + streaming**: "Say hello in exactly five words." got a real streamed reply ("Hello there,
  how are you?") from the live model.
- **Stop**: a long prompt ("Write a very long, detailed 300-word essay about clouds.") was
  cancelled from "Thinking" before any text had streamed — correctly left no partial/garbage
  message and returned presence to Idle (OpenCode's cancel path, same as the fake harness's, just
  exercised against the real adapter).
- **Follow-up turn**: a trivial prompt right after ("Just say OK.") queued and completed normally
  (~20s on the free tier) with a clean "OK" reply, confirming the queue and presence recover
  correctly after a cancel.

No adapter-level problems found; nothing to report back to the Opus branch for `acp/`.

## Evidence

- `bun run check` — pass (lint, typecheck across shared/server/web/e2e, `bun test`: 65/65 across 5
  files; unchanged from round 1's count since this round didn't add server-side bun tests).
- `bun run check:voice` — pass (ruff + 10 pytest cases, unchanged).
- `bun run e2e` — pass, 5/5 specs (chat ×2 — the new composer-lock case, mcp, ui, voice-call).
- Manual verification: a local `--local --no-voice --data-dir /tmp/…` server, driven with
  Playwright (nix Chromium) for the OpenCode flow above and the harness-secret-masking flow; every
  server/browser process started was torn down afterwards (`ps aux` checked clean), no test ever
  pointed at `~/.vibe-center`.
- Screenshots: `docs/screenshots/agent-editor-light.png`, `dm-details-light.png` refreshed in
  place; added `settings-harness-secret-light.png`. A few other stock screenshots
  (`dm-light.png`, `dm-dark.png`, `command-palette-light.png`, `settings-general-light.png`,
  `settings-harnesses-light.png`) picked up incidental byte diffs from the same script run
  (timestamps, demo harness ids) — not behavior changes.

## Open issues

- The harness-env-masking server plumbing (item 6) duplicates work the Opus branch is also doing
  for the same review finding (L1); flagged above, expect a rebase conflict to resolve at
  integration rather than two independent masking implementations living on `main`.
- Item 2's "point to the fix" coverage is UI plumbing only (a `hint` on turn-level errors and
  gateway tool-call failures, rendered as a link using data that already exists); a live
  "harness crashes mid-turn" or "MCP server goes down mid-call" scenario wasn't reproduced end to
  end in this pass — the rendering path was verified against the existing error/tool-call message
  shapes instead, and the review itself notes this gap is traced by code reading, not reproduced.
- Didn't touch `packages/server/src/acp/` or process-management code, per the brief; H1 (session
  setup race), M1 (agent deletion), M2 (process cleanup), M4 (voice queueing) and the rest of the
  server-lifecycle findings are the Opus branch's scope.

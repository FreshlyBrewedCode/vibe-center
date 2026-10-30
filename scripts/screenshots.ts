#!/usr/bin/env bun
// Renders the real app's screens to docs/screenshots/ for visual review: a throwaway server on a
// temp data dir, seeded through the API with the fake harness (packages/server/test/fake-agent.ts),
// driven with Playwright. Dark first, a light set for the main screens; desktop 1440×900 and a
// 390×844 phone at 2×. Includes a real voice call through the managed worker (the call card, the
// strip and the call sheet with a pending approval) unless VC_SHOTS_VOICE=0.
// Not part of `bun run check`/`e2e`; run by hand: `bun scripts/screenshots.ts`.
// Fonts: like design/explorations/shoot.ts, a fontconfig with Inter/JetBrains Mono/Noto Color Emoji
// is used when present (VC_FONTCONFIG, default /tmp/vc-fonts/conf/fonts.conf); the app bundles the
// text fonts itself, the emoji need the system.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type BrowserContext, chromium, type Page } from "@playwright/test";

const ROOT = join(import.meta.dirname, "..");
const PORT = Number(process.env.VC_SHOTS_PORT ?? 7901);
const DATA_DIR = mkdtempSync(join(tmpdir(), "vc-screenshots-"));
const OUT = join(ROOT, "docs/screenshots");
const FAKE_AGENT = join(ROOT, "packages/server/test/fake-agent.ts");
const VOICE = join(ROOT, "services/voice");
const CHROMIUM = existsSync(join(ROOT, ".chromium/bin/chromium"))
  ? join(ROOT, ".chromium/bin/chromium")
  : undefined;
const FONTCONFIG = process.env.VC_FONTCONFIG ?? "/tmp/vc-fonts/conf/fonts.conf";
const WITH_VOICE = process.env.VC_SHOTS_VOICE !== "0";
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

const api = (path: string) => `http://localhost:${PORT}${path}`;

function mintLink(): string {
  const out = execFileSync("bun", ["packages/server/src/cli.ts", "link", "--data-dir", DATA_DIR], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const m = /(http:\/\/localhost:\d+\/login#token=\S+)/.exec(out);
  if (!m?.[1]) throw new Error(`no link in output:\n${out}`);
  return m[1];
}

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 300; i++) {
    const ok = await fetch(api("/")).then(
      (r) => r.ok,
      () => false,
    );
    if (ok) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not start in time");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Lets a context's live socket go silent and refuse to reconnect (for the "Reconnecting…" pill). */
async function controllableSockets(context: BrowserContext) {
  let opened = 0;
  let deadUpTo = 0;
  const ctl = {
    refuse: false,
    blackhole: () => {
      deadUpTo = opened;
    },
  };
  await context.routeWebSocket("**/ws", (ws) => {
    if (ctl.refuse) return ws.close({ code: 1011, reason: "refused" });
    const id = ++opened;
    const server = ws.connectToServer();
    ws.onMessage((m) => id > deadUpTo && server.send(m));
    server.onMessage((m) => id > deadUpTo && ws.send(m));
  });
  return ctl;
}

async function dropNetwork(page: Page, ctl: Awaited<ReturnType<typeof controllableSockets>>) {
  ctl.blackhole();
  ctl.refuse = true;
  await page.getByTestId("connection-status").waitFor({ timeout: 40_000 });
}

interface Scenario {
  wav: string;
  duration: number;
  timeline: { id: string; start: number; end?: number; text: string }[];
}

/** The user's side of the call: a scripted WAV the fake microphone plays (cached by make_audio). */
function callAudio(): Scenario {
  const out = execFileSync(
    join(VOICE, "run.sh"),
    ["python", "-m", "tests.make_audio", "--out", join(VOICE, "tests/out")],
    { cwd: VOICE, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  return JSON.parse(out.trim().split("\n").at(-1)!) as Scenario;
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const args = ["packages/server/src/cli.ts", "start", "--local", "--no-probe", "--port", String(PORT)];
  args.push("--data-dir", DATA_DIR);
  if (!WITH_VOICE) args.push("--no-voice");
  const server: ChildProcess = spawn("bun", args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  server.stderr?.on("data", (d: Buffer) => {
    const line = d.toString();
    if (/error|Error/.test(line)) process.stderr.write(line);
  });
  const scenario = WITH_VOICE ? callAudio() : null;
  try {
    await waitForServer();
    const browser = await chromium.launch({
      executablePath: CHROMIUM,
      env: existsSync(FONTCONFIG) ? { ...process.env, FONTCONFIG_FILE: FONTCONFIG } : process.env,
      args: scenario
        ? [
            "--use-fake-ui-for-media-stream",
            "--use-fake-device-for-media-stream",
            `--use-file-for-fake-audio-capture=${scenario.wav}`,
            "--autoplay-policy=no-user-gesture-required",
          ]
        : [],
    });
    try {
      await shoot(browser, scenario);
    } finally {
      await browser.close();
    }
  } finally {
    server.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      server.on("exit", () => resolve());
      setTimeout(resolve, 8000);
    });
    rmSync(DATA_DIR, { recursive: true, force: true });
  }
}

interface Seed {
  robin: { id: string; conversationId: string };
  dana: { id: string; conversationId: string };
  juno: { id: string; conversationId: string };
}

/** Five agents with a spread of presences, and Robin's DM as the hero thread. */
async function seed(page: Page): Promise<Seed> {
  const post = async <T>(path: string, data: unknown): Promise<T> =>
    (await (await page.request.post(path, { data })).json()) as T;
  const harness = await post<{ id: string }>("/api/harnesses", {
    name: "Demo",
    command: "bun",
    args: [FAKE_AGENT],
  });
  await page.request.post(`/api/harnesses/${harness.id}/probe`);
  const broken = await post<{ id: string }>("/api/harnesses", {
    name: "OpenCode (demo)",
    command: "/bin/false",
    args: [],
  });
  type A = { id: string; conversationId: string };
  const agent = (
    name: string,
    emoji: string,
    color: string,
    description: string,
    harnessId = harness.id,
    model: string | null = "fake-smart",
  ) =>
    post<A>("/api/agents", {
      name,
      description,
      avatar: { emoji, color },
      harnessId,
      model,
      cwd: DATA_DIR,
      systemPrompt: `You are ${name}.`,
      voice: "af_heart",
    });
  const robin = await agent("Robin", "🐦", "#6366f1", "Coding agent on vibe-center");
  const dana = await agent("Dana", "🦊", "#f97316", "Manager · steers the others");
  const max = await agent("Max", "🛠️", "#10b981", "Infra · deploys and servers");
  const sage = await agent("Sage", "🌿", "#0ea5e9", "Research · reads papers, writes notes");
  const juno = await agent("Juno", "🪐", "#a855f7", "Writer · docs and release notes", broken.id, null);

  const say = (a: A, text: string) => post(`/api/conversations/${a.conversationId}/messages`, { text });
  const messages = async (a: A) =>
    (
      (await (await page.request.get(`/api/conversations/${a.conversationId}/messages`)).json()) as {
        messages: { role: string; kind: string; text: string; status: string }[];
      }
    ).messages;
  const until = async (
    a: A,
    pred: (m: { role: string; kind: string; text: string; status: string }) => boolean,
  ) => {
    for (let i = 0; i < 200; i++) {
      if ((await messages(a)).some(pred)) return;
      await sleep(100);
    }
    throw new Error("seed: timed out waiting for a message");
  };

  // Robin: a plan, a thought, a run of edits with a command, a reply with code.
  await say(
    robin,
    "Take the sidebar bug: the rail should collapse to 64px and remember the choice per device. Plan the edits first and share your thoughts.",
  );
  await until(
    robin,
    (m) => m.role === "agent" && m.kind === "text" && m.text.includes("remembered per device"),
  );
  // Dana relays a message to Robin (agent-to-agent), Robin answers it.
  await say(
    dana,
    'mcp-silent send_message_to_agent {"agent":"Robin","message":"Karl wants the whole mobile pass finished today. After the header, make sure the call bar stays visible too."}',
  );
  await until(robin, (m) => m.role === "agent" && m.text.includes("mobile pass"));
  await until(dana, (m) => m.role === "user" && m.text.includes("mobile pass"));
  // Dana thinks forever (presence: thinking), Max works for two minutes, Sage has unread, Juno errors.
  await say(dana, "hang on, think about the release plan");
  await say(max, "edits slowly: roll out the tailscale serve change");
  await say(sage, "Summarise what you read about turn detection latency.");
  await until(sage, (m) => m.role === "agent" && m.status === "complete");
  await say(juno, "Draft the release notes for the mobile pass.");
  await until(juno, (m) => m.kind === "error");
  await post("/api/memories", {
    content: "Karl prefers short replies in calls and wants every change committed in small steps.",
    tags: ["preferences", "calls"],
    agentId: null,
  });
  await post("/api/memories", {
    content:
      "The web app pins its root to the visual viewport (lib/viewport.ts); only the message list scrolls.",
    tags: ["web", "mobile"],
    agentId: robin.id,
  });
  return { robin, dana, juno };
}

async function shot(page: Page, name: string, opts: { fullPage?: boolean } = {}) {
  await page.evaluate(() => document.fonts.ready);
  await sleep(350);
  await page.screenshot({ path: join(OUT, `${name}.png`), animations: "disabled", ...opts });
  console.log(`wrote ${name}.png`);
}

async function setTheme(page: Page, theme: "dark" | "light") {
  await page.evaluate((t) => localStorage.setItem("vc-theme", t), theme);
  await page.reload();
  await page.waitForLoadState("networkidle");
}

async function setSidebar(page: Page, mode: "rail" | "expanded") {
  await page.evaluate((m) => localStorage.setItem("vc-sidebar", m), mode);
  await page.reload();
  await page.waitForLoadState("networkidle");
}

async function shoot(browser: Browser, scenario: Scenario | null): Promise<void> {
  const context: BrowserContext = await browser.newContext({
    baseURL: api(""),
    viewport: DESKTOP,
    colorScheme: "dark",
    permissions: ["microphone"],
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  page.on("console", (m) => m.type() === "error" && console.log(`[browser] ${m.text()}`));
  await page.goto(mintLink());
  await page.waitForLoadState("networkidle");
  const { robin, dana, juno } = await seed(page);

  // The approval card pending in Robin's DM (presence: needs approval).
  await page.request.post(`/api/conversations/${robin.conversationId}/messages`, {
    data: {
      text: 'Commit it as `git commit -am "web: keep the DM header sticky on mobile"` once you have permission.',
    },
  });

  // ---- desktop, dark ---------------------------------------------------------------------------
  await page.goto(`/agents/${robin.id}`);
  await page.getByTestId("permission").waitFor();
  // The rail: hover Dana for the tooltip.
  await page.getByTestId("sidebar-agent").filter({ hasText: "Dana" }).hover();
  await sleep(600);
  await shot(page, "dm-dark");
  await page.mouse.move(700, 450);

  await setSidebar(page, "expanded");
  await page.getByTestId("permission").waitFor();
  await shot(page, "dm-expanded-dark");

  await page.getByRole("button", { name: "Agent details" }).click();
  await sleep(300);
  await shot(page, "dm-details-dark");
  await page.getByRole("button", { name: "Close details" }).click();

  await page.keyboard.press("Control+k");
  await page.getByPlaceholder(/Switch agents/).waitFor();
  await shot(page, "palette-dark");
  await page.getByPlaceholder(/Switch agents/).fill("sidebar");
  await sleep(600);
  await shot(page, "palette-search-dark");
  await page.keyboard.press("Escape");

  await page.goto(`/agents/${dana.id}`);
  await page.getByTestId("relay").first().waitFor();
  await shot(page, "dm-relay-dark");

  await page.goto(`/agents/${juno.id}`);
  await page.getByTestId("message-system").or(page.getByText("Fix in Settings")).first().waitFor();
  await shot(page, "dm-error-dark");

  await page.goto("/");
  await sleep(200);
  await shot(page, "home-dark");

  await page.goto("/agents/new");
  await page.getByTestId("template-coding").waitFor();
  await shot(page, "new-agent-dark");
  await page.getByTestId("template-coding").click();
  await page.getByLabel("System prompt").waitFor();
  await shot(page, "agent-editor-dark");

  await page.goto(`/agents/${robin.id}/edit`);
  await page.getByTestId("agent-tools").waitFor();
  await page.getByTestId("tool-group-builtin").getByRole("button").click();
  await page.getByTestId("agent-tools").scrollIntoViewIfNeeded();
  await shot(page, "agent-editor-tools-dark");

  await page.goto("/memories");
  await page.getByTestId("memory").first().waitFor();
  await shot(page, "memories-dark");

  for (const [section, name] of [
    ["general", "settings-general-dark"],
    ["harnesses", "settings-harnesses-dark"],
    ["mcp", "settings-mcp-dark"],
    ["voice", "settings-voice-dark"],
    ["appearance", "settings-appearance-dark"],
  ] as const) {
    await page.goto(`/settings/${section}`);
    await page.waitForLoadState("networkidle");
    await sleep(300);
    await shot(page, name);
  }
  await page.goto("/settings/devices");
  await page.getByTestId("device").first().waitFor();
  await shot(page, "settings-devices-dark");
  await page.getByRole("button", { name: "Add device" }).click();
  await page.getByText(/Expires in/).waitFor();
  await shot(page, "settings-devices-add-device-dark");
  await page.keyboard.press("Escape");

  // Signed out: a fresh context without the session cookie.
  const anon = await browser.newContext({ baseURL: api(""), viewport: DESKTOP, colorScheme: "dark" });
  const anonPage = await anon.newPage();
  await anonPage.goto("/");
  await anonPage.getByText("Not signed in").waitFor();
  await shot(anonPage, "login-dark");
  await anon.close();

  // ---- phone, dark -----------------------------------------------------------------------------
  const phone = await browser.newContext({
    baseURL: api(""),
    viewport: PHONE,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    colorScheme: "dark",
    reducedMotion: "reduce",
    storageState: await context.storageState(),
  });
  const m = await phone.newPage();
  await m.goto("/");
  await m.getByRole("heading", { name: "Agents" }).waitFor();
  await sleep(300);
  await shot(m, "mobile-agents-dark");
  await m.getByTestId("agent-row").filter({ hasText: "Robin" }).click();
  await m.getByTestId("permission").waitFor();
  await shot(m, "mobile-dm-dark");
  await m.getByRole("button", { name: "Agent details" }).click();
  await sleep(300);
  await shot(m, "mobile-details-dark");
  await m.getByRole("button", { name: "Close details" }).click();
  await m.goto("/settings/voice");
  await m.waitForLoadState("networkidle");
  await sleep(300);
  await shot(m, "mobile-settings-dark");
  await m.goto("/memories");
  await m.getByTestId("memory").first().waitFor();
  await shot(m, "mobile-memories-dark");
  await m.goto("/agents/new");
  await m.getByTestId("template-coding").waitFor();
  await shot(m, "mobile-new-agent-dark");

  // ---- light ------------------------------------------------------------------------------------
  await setTheme(page, "light");
  await page.goto(`/agents/${robin.id}`);
  await page.getByTestId("permission").waitFor();
  await shot(page, "dm-light");
  await setSidebar(page, "rail");
  await page.getByTestId("permission").waitFor();
  await shot(page, "dm-rail-light");
  await page.keyboard.press("Control+k");
  await page.getByPlaceholder(/Switch agents/).waitFor();
  await shot(page, "palette-light");
  await page.keyboard.press("Escape");
  await page.goto("/settings/general");
  await page.waitForLoadState("networkidle");
  await sleep(300);
  await shot(page, "settings-general-light");
  await setTheme(m, "light");
  await m.goto("/");
  await m.getByRole("heading", { name: "Agents" }).waitFor();
  await sleep(300);
  await shot(m, "mobile-agents-light");
  await m.goto(`/agents/${robin.id}`);
  await m.getByTestId("permission").waitFor();
  await shot(m, "mobile-dm-light");
  await setTheme(m, "dark");
  await setTheme(page, "dark");
  await setSidebar(page, "expanded");

  // ---- the call ---------------------------------------------------------------------------------
  if (scenario) await call(browser, page, m, robin, scenario);
  await phone.close();
  await context.close();
  console.log(`Screenshots written to ${OUT}`);
}

/**
 * A real call with Robin through the managed voice worker: the fake microphone plays the
 * scripted scenario. Desktop card (listening/speaking, then waiting for approval, then from
 * another tab), the phone's strip and sheet, and the DM with the spoken rows afterwards.
 */
async function call(
  browser: Browser,
  page: Page,
  m: Page,
  robin: { id: string; conversationId: string },
  scenario: Scenario,
) {
  // The worker loads its models in the background after the app starts.
  for (let i = 0; i < 240; i++) {
    const s = (await (await page.request.get("/api/voice/status")).json()) as { worker: { state: string } };
    if (s.worker.state === "ok") break;
    await sleep(1000);
    if (i === 239) throw new Error("voice worker never became ready");
  }
  // Approve the pending request first, so the call starts in a plain listening state.
  await page.goto(`/agents/${robin.id}`);
  await page.getByTestId("permission").getByRole("button", { name: "Allow" }).click();
  await page.getByTestId("message-agent").filter({ hasText: "Permission granted" }).waitFor();
  await page.getByTestId("call-button").click();
  await page
    .getByTestId("call-state")
    .filter({ hasText: /Listening|Thinking|Speaking/ })
    .waitFor({ timeout: 30_000 });
  // A couple of exchanges in: the transcript has lines.
  const firstReply = scenario.timeline.find((t) => t.id !== "event" && t.start > 4) ?? scenario.timeline[1];
  await sleep(Math.max(0, (firstReply?.end ?? 8) * 1000 + 3000));
  await page.getByTestId("call-transcript").waitFor({ timeout: 20_000 });
  await shot(page, "dm-call-dark");

  // Waiting for approval, inside the call card.
  await page.request.post(`/api/conversations/${robin.conversationId}/messages`, {
    data: { text: "Ship it: `git push origin main`, after permission." },
  });
  await page.getByTestId("call-permission").waitFor();
  await shot(page, "dm-call-approval-dark");

  // The same call from a tab that doesn't hold the audio.
  const other = await page.context().newPage();
  await other.setViewportSize(DESKTOP);
  await other.goto(`/agents/${robin.id}`);
  await other.getByTestId("call-elsewhere").waitFor();
  await shot(other, "dm-call-elsewhere-dark");
  await other.close();

  // Phone: the strip under the header, then the full-screen sheet. The phone context is another
  // tab of the same device, so it shows the call (audio stays in the desktop tab).
  await m.goto(`/agents/${robin.id}`);
  await m.getByTestId("call-bar").waitFor();
  await shot(m, "mobile-call-dark");
  await m.getByRole("button", { name: "Open the call" }).click();
  await m.getByRole("dialog", { name: /Call with/ }).waitFor();
  await sleep(300);
  await shot(m, "mobile-call-sheet-dark");
  await m.getByRole("button", { name: "chat" }).click();

  // Approve from the card, let the scenario finish, hang up: the DM shows the spoken rows.
  await page.getByTestId("call-permission").getByRole("button", { name: "Allow" }).click();
  await sleep(Math.max(0, scenario.duration * 1000 - 20_000));
  await page.getByTestId("call-hangup").click();
  await page.getByTestId("call-bar").waitFor({ state: "detached" });
  await page.getByText("Spoken").first().waitFor();
  await shot(page, "dm-voice-dark");
  await m.goto(`/agents/${robin.id}`);
  await m.getByText("Spoken").first().waitFor();
  await shot(m, "mobile-dm-voice-dark");
  void browser;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

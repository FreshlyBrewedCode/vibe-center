import { type BrowserContext, devices, expect, type Page, test } from "@playwright/test";
import type { AgentView, Harness } from "../packages/shared/src/index.ts";
import { dataDir, FAKE_AGENT, mintLink } from "./helpers.ts";

// A phone's tab on a flaky connection: the screen locks (the tab freezes, its socket dies without
// a `close`), the user comes back. Missed messages and permission requests must show without a
// reload, the live channel must notice a dead socket by itself, and the DM's headers stay put.

const { defaultBrowserType: _, ...iPhone } = devices["iPhone 13"];
test.use(iPhone);

/**
 * Proxies the page's event sockets so a test can kill them silently: `blackhole()` stops every
 * socket open so far from passing anything in either direction, without closing it (what a
 * locked phone's network does). `refuse` makes new sockets fail to connect.
 */
async function controllableSockets(context: BrowserContext) {
  let opened = 0;
  let deadUpTo = 0;
  const ctl = {
    refuse: false,
    get opened() {
      return opened;
    },
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

async function setup(page: Page): Promise<AgentView> {
  await page.goto(mintLink());
  await expect(page.getByRole("button", { name: "Open agent list" })).toBeVisible();
  const harness = (await (
    await page.request.post("/api/harnesses", { data: { name: "Fake", command: "bun", args: [FAKE_AGENT] } })
  ).json()) as Harness;
  const agent = (await (
    await page.request.post("/api/agents", {
      data: { name: "Echo", avatar: { emoji: "🦜", color: "#22aa88" }, harnessId: harness.id, cwd: dataDir },
    })
  ).json()) as AgentView;
  await page.goto(`/agents/${agent.id}`);
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
  // the page's own marker: gone if anything reloads it
  await page.evaluate(() => {
    (window as unknown as { __notReloaded: boolean }).__notReloaded = true;
  });
  return agent;
}

const say = (page: Page, agent: AgentView, text: string) =>
  page.request.post(`/api/conversations/${agent.conversationId}/messages`, { data: { text } });

const notReloaded = (page: Page) =>
  page.evaluate(() => (window as unknown as { __notReloaded?: boolean }).__notReloaded === true);

/** Back to the tab: what a phone fires when the screen is unlocked. */
const comeBack = (page: Page) =>
  page.evaluate(() => {
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: false }));
  });

test("phone: the headers and the composer stay in view while the messages scroll", async ({ page }) => {
  const agent = await setup(page);
  for (let i = 0; i < 14; i++)
    await say(page, agent, `whoami ${i} ${"lorem ipsum dolor sit amet ".repeat(5)}`);
  await expect(page.getByTestId("message-agent")).toHaveCount(14, { timeout: 20_000 });

  const inView = async () => {
    const vh = await page.evaluate(() => innerHeight);
    for (const el of [
      page.getByRole("button", { name: "Open agent list" }),
      page.getByRole("button", { name: "Agent details" }),
      page.getByLabel("Message", { exact: true }),
    ]) {
      const box = (await el.boundingBox())!;
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(vh);
    }
  };
  // the document itself never scrolls: only the message list does
  expect(await page.evaluate(() => document.scrollingElement!.scrollHeight <= innerHeight)).toBe(true);
  const list = page.getByTestId("message-list");
  await list.evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.mouse.move(195, 400);
  await page.mouse.wheel(0, 5000);
  await page.evaluate(() => window.scrollTo(0, 10_000));
  expect(await page.evaluate(() => scrollY)).toBe(0);
  await inView();
  await list.evaluate((el) => {
    el.scrollTop = 0;
  });
  await inView();
  await page.screenshot({ path: "test-results/mobile-dm-scrolled.png" });
});

test("screen off: a frozen tab whose socket died shows what it missed when it comes back", async ({
  page,
  context,
}) => {
  const sockets = await controllableSockets(context);
  const agent = await setup(page);
  const cdp = await context.newCDPSession(page);

  // Lock the screen: the tab freezes and its connection dies without a close.
  const before = sockets.opened;
  await cdp.send("Page.setWebLifecycleState", { state: "frozen" });
  sockets.blackhole();
  await say(page, agent, "whoami while you were away");
  await say(page, agent, "permission please");
  await page.waitForTimeout(1500);

  // Unlock: the page probes its socket, finds it dead, reconnects and refetches.
  await cdp.send("Page.setWebLifecycleState", { state: "active" });
  await comeBack(page);
  await expect(page.getByTestId("permission")).toContainText("Run rm -rf build", { timeout: 10_000 });
  await expect(page.getByTestId("message-user").filter({ hasText: "while you were away" })).toBeVisible();
  await expect(page.getByTestId("mobile-presence")).toContainText("Needs approval");
  expect(sockets.opened).toBe(before + 1); // reconnected once, didn't reload
  expect(await notReloaded(page)).toBe(true);

  // The new socket is live: approving streams the reply in.
  await page.getByTestId("permission").getByRole("button", { name: "Allow" }).click();
  await expect(page.getByTestId("message-agent").last()).toContainText("Permission granted, ran it.");
});

test("a socket that dies silently is caught by the heartbeat; the page says it's reconnecting", async ({
  page,
  context,
}) => {
  test.setTimeout(90_000);
  const sockets = await controllableSockets(context);
  const agent = await setup(page);

  // The tab stays visible; nothing tells it the connection is gone, and it can't reconnect yet.
  sockets.blackhole();
  sockets.refuse = true;
  await say(page, agent, "whoami missed while offline");
  await expect(page.getByTestId("connection-status")).toHaveText("Reconnecting…", { timeout: 25_000 });
  await page.screenshot({ path: "test-results/mobile-reconnecting.png" });

  // The network is back: the next attempt connects and resyncs, without a reload.
  sockets.refuse = false;
  await expect(page.getByTestId("message-user").filter({ hasText: "missed while offline" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId("connection-status")).toHaveCount(0);
  expect(await notReloaded(page)).toBe(true);
});

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

const ROOT = join(import.meta.dirname, "..");
const FAKE_AGENT = join(ROOT, "packages/server/test/fake-agent.ts");
const dataDir = process.env.VC_E2E_DATA_DIR!;

/** `vibe-center link` against the running test server; returns the localhost sign-in link. */
function mintLink(): string {
  const out = execFileSync("bun", ["packages/server/src/cli.ts", "link", "--data-dir", dataDir], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const m = /(http:\/\/localhost:\d+\/login#token=\S+)/.exec(out);
  if (!m?.[1]) throw new Error(`no link in output:\n${out}`);
  return m[1];
}

test("sign in, create an agent, chat with streaming, stop, permissions, new session", async ({ page }) => {
  // Without a session the app shows the signed-out screen.
  await page.goto("/");
  await expect(page.getByText("Not signed in")).toBeVisible();

  // Token link → device cookie. The token is single-use.
  const link = mintLink();
  await page.goto(link);
  await expect(page.getByText("Create your first agent")).toBeVisible();
  expect(page.url()).not.toContain("token=");

  // A custom harness running the fake ACP agent, probed for its models.
  const harness = await (
    await page.request.post("/api/harnesses", {
      data: {
        name: "Fake",
        command: "bun", // Playwright workers run on node; the fake agent needs bun
        args: [FAKE_AGENT],
      },
    })
  ).json();
  expect((await page.request.post(`/api/harnesses/${harness.id}/probe`)).ok()).toBe(true);

  // Create an agent through the form.
  await page.getByRole("link", { name: "New agent" }).first().click();
  await page.getByLabel("Name").fill("Echo");
  await page.getByLabel("System prompt").fill("You are Echo.");
  await page.getByRole("combobox", { name: "Harness" }).click();
  await page.getByRole("option", { name: "Fake" }).click();
  await page.getByRole("combobox", { name: "Model" }).click();
  await page.getByRole("option", { name: "Fake Smart" }).click();
  await page.getByLabel("Working directory").fill(dataDir);
  await page.getByRole("button", { name: "Create agent" }).click();
  await expect(page.getByTestId("sidebar-agent").filter({ hasText: "Echo" })).toBeVisible();

  // Send a message and get a streamed reply.
  const composer = page.getByLabel("Message");
  await composer.fill("whoami");
  await composer.press("Enter");
  const reply = page.getByTestId("message-agent").last();
  await expect(reply).toContainText("SYSTEM=[You are Echo.]");
  await expect(reply).toContainText("MODEL=[fake-smart]");
  await expect(page.getByTestId("presence")).toHaveText("Idle");

  // A long reply streams in; Stop cancels it.
  await composer.fill("slow");
  await composer.press("Enter");
  await expect(page.getByTestId("message-agent").last()).toContainText("chunk 1.");
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByTestId("message-agent").last()).toContainText("Stopped");
  await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0);
  const stoppedText = await page.getByTestId("message-agent").last().textContent();
  expect(stoppedText ?? "").not.toContain("chunk 39.");

  // Tool calls render as cards; permission requests are approved from the UI.
  await composer.fill("permission please");
  await composer.press("Enter");
  await expect(page.getByTestId("permission")).toContainText("Run rm -rf build");
  await expect(page.getByTestId("presence")).toContainText("Needs approval");
  await page.getByTestId("permission").getByRole("button", { name: "Allow" }).click();
  await expect(page.getByTestId("message-agent").last()).toContainText("Permission granted, ran it.");
  await expect(page.getByTestId("permission")).toContainText("Answered: Allow");
  await expect(page.getByTestId("tool-call").last()).toHaveAttribute("data-status", "completed");

  // New session: a divider, and the harness starts a fresh session.
  await page.getByRole("button", { name: "New session" }).click();
  await expect(page.getByTestId("session-divider")).toBeVisible();
  await composer.fill("history");
  await composer.press("Enter");
  await expect(page.getByTestId("message-agent").last()).toContainText("This session has seen 1 prompts.");

  // Everything survives a reload (persisted, refetched).
  await page.reload();
  await expect(page.getByTestId("message-agent").first()).toContainText("SYSTEM=[You are Echo.]");
  await page.screenshot({ path: "test-results/dm.png" });
});

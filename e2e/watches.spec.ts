import { expect, test } from "@playwright/test";
import { dataDir, FAKE_AGENT, mintLink } from "./helpers";

// Background waits: the agent sets a timer instead of blocking; the DM shows what it waits on,
// then the event and the agent's new turn. Cancelling from the details panel stops a watch.
test("an agent's timer shows as waiting, then fires a new turn; a watch can be cancelled", async ({
  page,
}) => {
  await page.goto(mintLink());
  await expect(page.getByRole("link", { name: "Settings" })).toBeVisible();
  const harness = await (
    await page.request.post("/api/harnesses", {
      data: { name: "Fake watches", command: "bun", args: [FAKE_AGENT] },
    })
  ).json();
  const agent = await (
    await page.request.post("/api/agents", {
      data: {
        name: "Patience",
        avatar: { emoji: "⏳", color: "#6688aa" },
        harnessId: harness.id,
        cwd: dataDir,
      },
    })
  ).json();
  await page.goto(`/agents/${agent.id}`);

  const composer = page.getByLabel("Message");
  await composer.fill('mcp-call watch_timer {"note":"tell the user the coffee is ready","in_minutes":0.05}');
  await composer.press("Enter");
  const chip = page.getByTestId("waiting-chip");
  await expect(chip).toHaveText("Waiting on Timer: 3 s");

  // the timer fires: an Event row, the agent's new turn, and nothing left to wait on
  await expect(page.getByTestId("fired-watch")).toHaveText("Timer: 3 s", { timeout: 15_000 });
  await expect(page.getByText(/^Timer: 3 s is up/)).toBeVisible();
  await expect(chip).toBeHidden();
  await expect(page.getByText(/tell the user the coffee is ready/).last()).toBeVisible();

  // another timer, cancelled from the details panel
  await composer.fill('mcp-call watch_timer {"note":"later","in_minutes":30,"label":"Standup"}');
  await composer.press("Enter");
  await expect(chip).toHaveText("Waiting on Standup");
  await chip.click();
  const list = page.getByTestId("watch-list");
  await expect(list.getByTestId("watch").first()).toContainText("Standup");
  await list.getByRole("button", { name: "Cancel Standup" }).click();
  await expect(chip).toBeHidden();
  await expect(list).toContainText("Cancelled");
  await expect(list).toContainText("Fired");
});

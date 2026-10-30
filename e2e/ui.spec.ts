import { expect, test } from "@playwright/test";
import { dataDir, FAKE_AGENT, mintLink } from "./helpers";

test("template picker, ⌘K switch/search, details panel, edit, theme, mobile, device revoke", async ({
  page,
}) => {
  await page.goto(mintLink());
  await expect(page.locator("body")).toBeVisible();

  const harness = await (
    await page.request.post("/api/harnesses", {
      data: { name: "FakeUI", command: "bun", args: [FAKE_AGENT] },
    })
  ).json();
  await page.request.post(`/api/harnesses/${harness.id}/probe`);

  async function createAgent(templateId: string, name: string, promptPattern?: RegExp) {
    await page.getByRole("link", { name: "New agent" }).first().click();
    await page.getByTestId(`template-${templateId}`).click();
    if (promptPattern) await expect(page.getByLabel("System prompt")).toHaveValue(promptPattern);
    await page.getByLabel("Name").fill(name);
    await page.getByRole("combobox", { name: "Harness" }).click();
    await page.getByRole("option", { name: "FakeUI" }).click();
    await page.getByLabel("Working directory").fill(dataDir);
    await page.getByRole("button", { name: "Create agent" }).click();
    await expect(page.getByTestId("sidebar-agent").filter({ hasText: name })).toBeVisible();
  }

  // Template picker: the "Coding agent" template pre-fills a harness (before we swap it for the
  // test's fake one below), a starter prompt and a voice, and applies its tool preset after create.
  await page.getByRole("link", { name: "New agent" }).first().click();
  await page.getByTestId("template-coding").click();
  await expect(page.getByLabel("System prompt")).toHaveValue(/careful, direct coding assistant/);
  await expect(page.getByRole("combobox", { name: "Harness" })).toHaveText("Claude Code");
  await page.getByLabel("Name").fill("First");
  await page.getByRole("combobox", { name: "Harness" }).click();
  await page.getByRole("option", { name: "FakeUI" }).click();
  await page.getByLabel("Working directory").fill(dataDir);
  await page.getByRole("button", { name: "Create agent" }).click();
  await expect(page.getByTestId("sidebar-agent").filter({ hasText: "First" })).toBeVisible();

  // The coding template turns the "message other agents" tool off and leaves memory on.
  await page.getByRole("link", { name: "Edit agent" }).click();
  await page.getByTestId("tool-group-builtin").getByRole("button").click();
  await expect(page.getByRole("switch", { name: "send_message_to_agent" })).not.toBeChecked();
  await expect(page.getByRole("switch", { name: "memory_save" })).toBeChecked();
  await page.goBack();

  await createAgent("blank", "Second");

  // Back to First's DM, send a message with a unique token to search for later.
  await page.getByTestId("sidebar-agent").filter({ hasText: "First" }).click();
  const composer = page.getByLabel("Message");
  await composer.fill("whoami zebraquokka123");
  await composer.press("Enter");
  await expect(page.getByTestId("message-agent").last()).toContainText("zebraquokka123");

  // ⌘K: switch agents.
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog");
  await palette.getByPlaceholder(/Switch agents/).fill("Second");
  await palette.getByRole("option", { name: /Second/ }).click();
  await expect(page.getByTestId("presence")).toBeVisible();
  await expect(page).toHaveURL(/\/agents\//);

  // ⌘K: global message search with jump-to-message.
  await page.keyboard.press("Control+k");
  await palette.getByPlaceholder(/Switch agents/).fill("zebraquokka123");
  await expect(palette.getByRole("option", { name: /zebraquokka123/i }).first()).toBeVisible();
  await palette
    .getByRole("option", { name: /zebraquokka123/i })
    .first()
    .click();
  await expect(page.getByText(/zebraquokka123/).first()).toBeVisible();

  // Details panel: duplicate the agent we just jumped to.
  await page.getByRole("button", { name: "Agent details" }).click();
  await page.getByRole("button", { name: "Duplicate agent" }).click();
  await expect(page.getByText(/Duplicated as/)).toBeVisible();
  await expect(page.getByTestId("sidebar-agent").filter({ hasText: "First copy" })).toBeVisible();

  // Edit the duplicate and delete it, with confirmation.
  await page.getByTestId("sidebar-agent").filter({ hasText: "First copy" }).click();
  await page.getByRole("link", { name: "Edit agent" }).click();
  await page.getByRole("button", { name: "Delete agent" }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByTestId("sidebar-agent").filter({ hasText: "First copy" })).toHaveCount(0);

  // Appearance: switching to dark applies the .dark class.
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("link", { name: "Appearance" }).click();
  await page.getByRole("combobox", { name: "Theme" }).click();
  await page.getByRole("option", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);

  // Mobile viewport: the persistent sidebar is replaced by a hamburger + drawer, and the agent's
  // name/presence show once, in the top bar (not duplicated in the DM header below it).
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId("sidebar-agent").first()).not.toBeVisible();
  await page.getByRole("button", { name: "Open agent list" }).click();
  await page.getByRole("link", { name: /Second/ }).click();
  await expect(page.getByTestId("mobile-presence")).toBeVisible();
  await expect(page.getByTestId("presence")).not.toBeVisible();
  await page.setViewportSize({ width: 1280, height: 800 });

  // Device revoke: confirming for "this device" signs it out.
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("link", { name: "Devices" }).click();
  await page
    .getByTestId("device")
    .filter({ hasText: "(this device)" })
    .getByRole("button", { name: "Revoke" })
    .click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByText("Not signed in")).toBeVisible();
});

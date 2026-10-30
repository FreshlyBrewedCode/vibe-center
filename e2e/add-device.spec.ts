import { expect, test } from "@playwright/test";
import { mintLink } from "./helpers";

test("Add device: a minted link pairs a second browser live, then rename and revoke it", async ({
  page,
  browser,
}) => {
  // Device A: sign in and open Settings → Devices → Add device.
  await page.goto(mintLink());
  await expect(page.getByRole("link", { name: "New agent" }).first()).toBeVisible();
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("link", { name: "Devices" }).click();
  await page.getByRole("button", { name: "Add device" }).click();
  await expect(page.getByText(/Expires in \d+:\d+/)).toBeVisible();

  // Pre-assign a name, then mint the link that carries it.
  await page.getByLabel("Device name").fill("Phone");
  await page.getByRole("button", { name: "Generate new" }).click();
  await expect(page.getByText(/Expires in \d+:\d+/)).toBeVisible();
  const link = await page.getByLabel("Sign-in link").inputValue();

  // Device B: a second browser context opens the link (standing in for "scan the QR code").
  const deviceB = await browser.newContext();
  const pageB = await deviceB.newPage();
  await pageB.goto(link);
  await expect(pageB.getByRole("link", { name: "New agent" }).first()).toBeVisible();

  // Device A's dialog shows the pairing live, without a reload.
  await expect(page.getByText("Paired: Phone")).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();

  // The new device appears in the list live too.
  const row = page.getByTestId("device").filter({ hasText: "Phone" });
  await expect(row).toBeVisible();

  // Rename it from device A's list.
  await row.getByRole("button", { name: "Rename device" }).click();
  await page.getByLabel("New device name").fill("Phone 2");
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(page.getByTestId("device").filter({ hasText: "Phone 2" })).toBeVisible();

  // Revoke it: device B is signed out live.
  await page
    .getByTestId("device")
    .filter({ hasText: "Phone 2" })
    .getByRole("button", { name: "Revoke" })
    .click();
  await expect(pageB.getByText("Not signed in")).toBeVisible();
  await deviceB.close();
});

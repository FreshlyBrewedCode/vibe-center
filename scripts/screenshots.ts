#!/usr/bin/env bun
// One-off script: boots a throwaway server, drives the app with Playwright, and saves
// screenshots of the main screens under docs/screenshots/ for visual review. Not part of
// `bun run check`/`e2e` — run by hand: `bun scripts/screenshots.ts`.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const ROOT = join(import.meta.dirname, "..");
const PORT = 7901;
const DATA_DIR = mkdtempSync(join(tmpdir(), "vc-screenshots-"));
const OUT = join(ROOT, "docs/screenshots");
const FAKE_AGENT = join(ROOT, "packages/server/test/fake-agent.ts");
const CHROMIUM = existsSync(join(ROOT, ".chromium/bin/chromium"))
  ? join(ROOT, ".chromium/bin/chromium")
  : undefined;

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
  for (let i = 0; i < 100; i++) {
    const ok = await fetch(`http://localhost:${PORT}/`).then(
      (r) => r.ok,
      () => false,
    );
    if (ok) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not start in time");
}

async function main(): Promise<void> {
  const server: ChildProcess = spawn(
    "bun",
    [
      "packages/server/src/cli.ts",
      "start",
      "--local",
      "--no-probe",
      "--port",
      String(PORT),
      "--data-dir",
      DATA_DIR,
    ],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
  );
  try {
    await waitForServer();

    const browser = await chromium.launch(CHROMIUM ? { executablePath: CHROMIUM } : {});
    try {
      await shoot(browser);
    } finally {
      await browser.close();
    }
  } finally {
    server.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 300));
    rmSync(DATA_DIR, { recursive: true, force: true });
  }
}

async function shoot(browser: import("@playwright/test").Browser): Promise<void> {
  const context = await browser.newContext({
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1360, height: 860 },
  });
  const page = await context.newPage();

  await page.goto(mintLink());
  await page.waitForLoadState("networkidle");

  const harness = await (
    await page.request.post("/api/harnesses", { data: { name: "Demo", command: "bun", args: [FAKE_AGENT] } })
  ).json();
  await page.request.post(`/api/harnesses/${harness.id}/probe`);

  async function createAgent(templateId: string, name: string) {
    await page.getByRole("link", { name: "New agent" }).first().click();
    await page.getByTestId(`template-${templateId}`).click();
    await page.getByLabel("Name").fill(name);
    await page.getByRole("combobox", { name: "Harness" }).click();
    await page.getByRole("option", { name: "Demo" }).click();
    await page.getByLabel("Working directory").fill(DATA_DIR);
    await page.getByRole("button", { name: "Create agent" }).click();
    await page.getByTestId("sidebar-agent").filter({ hasText: name }).waitFor();
  }

  await createAgent("coding", "Dana");
  await createAgent("manager", "Max");
  await createAgent("blank", "Robin");

  const composer = page.getByLabel("Message");
  await composer.fill("tool");
  await composer.press("Enter");
  await page.getByTestId("tool-call").last().waitFor();
  await composer.fill("plan");
  await composer.press("Enter");
  await page.waitForTimeout(300);
  await composer.fill("permission please");
  await composer.press("Enter");
  await page.getByTestId("permission").waitFor();

  await page.screenshot({ path: join(OUT, "dm-light.png") });

  await page.getByRole("button", { name: "Agent details" }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, "dm-details-light.png") });
  await page.getByRole("button", { name: "Close details" }).click();

  await page.keyboard.press("Control+k");
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, "command-palette-light.png") });
  await page.keyboard.press("Escape");

  await page.getByRole("link", { name: "New agent" }).first().click();
  await page.waitForTimeout(100);
  await page.screenshot({ path: join(OUT, "template-picker-light.png") });
  await page.getByTestId("template-coding").click();
  await page.waitForTimeout(100);
  await page.screenshot({ path: join(OUT, "agent-editor-light.png") });
  await page.goBack();
  await page.goBack();

  await page.getByRole("link", { name: "Settings" }).click();
  await page.waitForTimeout(100);
  await page.screenshot({ path: join(OUT, "settings-general-light.png") });
  await page.getByRole("link", { name: "Harnesses" }).click();
  await page.waitForTimeout(100);
  await page.screenshot({ path: join(OUT, "settings-harnesses-light.png") });

  // Dark theme.
  await page.getByRole("link", { name: "Appearance" }).click();
  await page.getByRole("combobox", { name: "Theme" }).click();
  await page.getByRole("option", { name: "Dark" }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, "settings-appearance-dark.png") });
  await page.getByTestId("sidebar-agent").first().click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, "dm-dark.png") });

  // Mobile viewport, still dark.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, "dm-mobile-dark.png") });
  await page.getByRole("button", { name: "Open agent list" }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, "mobile-drawer-dark.png") });

  console.log(`Screenshots written to ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

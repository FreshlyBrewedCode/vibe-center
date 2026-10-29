import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

// One throwaway server per run: temp data dir, localhost only, no harness probing. Workers
// inherit the env var, so the spec finds the same data dir (for `vibe-center link`).
process.env.VC_E2E_DATA_DIR ??= mkdtempSync(join(tmpdir(), "vc-e2e-"));
const port = Number(process.env.VC_E2E_PORT ?? 7899);
// Playwright's downloaded browsers don't run on NixOS: use a nix chromium if one is linked
// (`nix build nixpkgs#chromium -o .chromium`) or named in VC_E2E_CHROMIUM.
const chromium =
  process.env.VC_E2E_CHROMIUM ??
  (existsSync(".chromium/bin/chromium") ? ".chromium/bin/chromium" : undefined);

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? "line" : "list",
  timeout: 60_000,
  use: {
    baseURL: `http://localhost:${port}`,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], launchOptions: chromium ? { executablePath: chromium } : {} },
    },
  ],
  webServer: {
    command: `bun packages/server/src/cli.ts start --local --no-probe --port ${port} --data-dir ${process.env.VC_E2E_DATA_DIR}`,
    url: `http://localhost:${port}/`,
    reuseExistingServer: false,
    stdout: "pipe",
    gracefulShutdown: { signal: "SIGTERM", timeout: 5000 },
  },
});

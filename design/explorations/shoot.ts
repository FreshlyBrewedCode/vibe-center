// Renders every direction's screens to screenshots/<n>-<slug>-<screen>.png with Playwright.
// Run from this folder: `bun shoot.ts [slug…]`. Uses the nix chromium linked at the repo root
// (`.chromium`, see AGENTS.md) and, if present, a fontconfig file with Inter, JetBrains Mono,
// Fraunces and Noto Color Emoji (VC_FONTCONFIG, default /tmp/vc-fonts/conf/fonts.conf).
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { createServer } from "vite";
import { MANIFEST, SCREENS } from "./src/manifest";

const here = import.meta.dirname;
const root = resolve(here, "../..");
const only = new Set(process.argv.slice(2));
const executablePath =
  process.env.VC_E2E_CHROMIUM ??
  (existsSync(resolve(root, ".chromium/bin/chromium")) ? resolve(root, ".chromium/bin/chromium") : undefined);
const fontconfig = process.env.VC_FONTCONFIG ?? "/tmp/vc-fonts/conf/fonts.conf";

const server = await createServer({
  configFile: resolve(here, "vite.config.ts"),
  root: here,
  logLevel: "error",
});
await server.listen();
const port = server.config.server.port;
const base = `http://127.0.0.1:${port}/`;

const browser = await chromium.launch({
  executablePath,
  env: existsSync(fontconfig) ? { ...process.env, FONTCONFIG_FILE: fontconfig } : process.env,
});

try {
  for (const d of MANIFEST) {
    if (only.size && !only.has(d.slug)) continue;
    const shots: { hash: string; file: string; viewport: [number, number]; dark: boolean }[] = d.shots
      ? d.shots.map((s) => ({
          hash: `${d.slug}/${s.screen}`,
          file: `${d.index}-${d.file ?? d.slug}-${s.label}`,
          viewport: s.viewport,
          dark: s.dark,
        }))
      : SCREENS.map((s) => ({
          hash: `${d.slug}/${s}`,
          file: `${d.index}-${d.slug}-${s === "extra" ? d.extra.label : s}`,
          viewport: s === "extra" ? d.extra.viewport : s === "mobile-call" ? [390, 844] : [1440, 900],
          dark: d.dark,
        }));
    for (const b of d.bonus ?? [])
      shots.push({
        hash: b.hash,
        file: `${d.index}-${d.slug}-${b.label}`,
        viewport: b.viewport,
        dark: d.dark,
      });
    for (const s of shots) {
      const mobile = s.viewport[0] < 500;
      const context = await browser.newContext({
        viewport: { width: s.viewport[0], height: s.viewport[1] },
        deviceScaleFactor: mobile ? 2 : 1,
        colorScheme: s.dark ? "dark" : "light",
        reducedMotion: "reduce",
      });
      const page = await context.newPage();
      await page.goto(`${base}#/${s.hash}`);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(400);
      const path = resolve(here, "screenshots", `${s.file}.png`);
      await page.screenshot({ path, animations: "disabled" });
      console.log(`wrote ${path}`);
      await context.close();
    }
  }
} finally {
  await browser.close();
  await server.close();
}

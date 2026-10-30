import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isBuildStale, writeStamp } from "../src/build-stamp.ts";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "vc-build-stamp-"));
  const srcDir = join(root, "src");
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(join(srcDir, "app.tsx"), "export const App = () => null;");
  const distDir = join(root, "dist");
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(distDir, "index.html"), "<html></html>");
  const sources = { src: srcDir };
  return { root, distDir, sources };
}

describe("isBuildStale", () => {
  test("missing build is stale", () => {
    const { distDir, sources } = setup();
    mkdirSync(distDir, { recursive: true });
    const emptyDist = join(distDir, "../dist-missing");
    expect(isBuildStale(emptyDist, sources)).toBe(true);
  });

  test("fresh after writing the stamp", () => {
    const { distDir, sources } = setup();
    writeStamp(distDir, sources);
    expect(isBuildStale(distDir, sources)).toBe(false);
  });

  test("stale once a source file changes after the stamp was written", async () => {
    const { distDir, sources } = setup();
    writeStamp(distDir, sources);
    expect(isBuildStale(distDir, sources)).toBe(false);

    // Bump the source file's mtime forward so it's unambiguously newer than the stamp, even on
    // filesystems with coarse mtime resolution.
    const future = new Date(Date.now() + 60_000);
    utimesSync(join(sources.src, "app.tsx"), future, future);

    expect(isBuildStale(distDir, sources)).toBe(true);
  });
});

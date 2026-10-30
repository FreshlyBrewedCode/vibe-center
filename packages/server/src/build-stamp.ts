import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Paths (files or directories) that feed the web build. Missing entries are skipped, so this
 * works whether or not a given file exists (e.g. no lockfile yet).
 */
export type WebBuildSources = Record<string, string>;

const STAMP_FILE = ".build-stamp";

export function stampPath(distDir: string): string {
  return join(distDir, STAMP_FILE);
}

/** Newest mtime (ms since epoch) across every source path, as a string stamp. */
export function currentStamp(sources: WebBuildSources): string {
  let newest = 0;
  for (const path of Object.values(sources)) newest = Math.max(newest, newestMtime(path));
  return String(newest);
}

function newestMtime(path: string): number {
  if (!existsSync(path)) return 0;
  const st = statSync(path);
  if (!st.isDirectory()) return st.mtimeMs;
  let newest = st.mtimeMs;
  for (const entry of readdirSync(path)) newest = Math.max(newest, newestMtime(join(path, entry)));
  return newest;
}

function readStamp(distDir: string): string | null {
  const p = stampPath(distDir);
  if (!existsSync(p)) return null;
  return readFileSync(p, "utf8").trim();
}

export function writeStamp(distDir: string, sources: WebBuildSources): void {
  writeFileSync(stampPath(distDir), currentStamp(sources));
}

/** True if there's no build, or the build predates a change to one of `sources`. */
export function isBuildStale(distDir: string, sources: WebBuildSources): boolean {
  if (!existsSync(join(distDir, "index.html"))) return true;
  return readStamp(distDir) !== currentStamp(sources);
}

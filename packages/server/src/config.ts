import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Where everything the app stores lives. Override with --data-dir or VIBE_CENTER_DATA_DIR. */
export function resolveDataDir(flag?: string): string {
  const dir = flag ?? process.env.VIBE_CENTER_DATA_DIR ?? join(homedir(), ".vibe-center");
  return resolve(expandHome(dir));
}

export function dataPaths(dataDir: string) {
  return {
    db: join(dataDir, "vibe-center.db"),
    /** Control socket for `vibe-center link` (mode 0600, inside the 0700 data dir). */
    controlSocket: join(dataDir, "control.sock"),
    /** Per-agent scratch dirs for generated harness config. */
    agentState: (agentId: string) => join(dataDir, "agents", agentId),
    logs: join(dataDir, "logs"),
    /** One file per live child process group, for reaping after a crash (procs.ts). */
    run: join(dataDir, "run"),
  };
}

/**
 * Create the data dir private to the user (0700), and tighten it if it already exists with a
 * looser mode: it holds the DB with MCP secrets, device hashes and the voice worker token.
 */
export function ensureDataDir(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
}

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/** Shown in Settings → General. Bump by hand; no release pipeline yet. */
export const VERSION = "0.1.0";

export const DEFAULT_PORT = 7880;
/** 443 and 8443 are already served on dev (docs/ARCHITECTURE.md, Auth). */
export const DEFAULT_HTTPS_PORT = 7443;

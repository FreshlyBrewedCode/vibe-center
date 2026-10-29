import { execFileSync } from "node:child_process";
import { join } from "node:path";

export const ROOT = join(import.meta.dirname, "..");
export const FAKE_AGENT = join(ROOT, "packages/server/test/fake-agent.ts");
export const dataDir = process.env.VC_E2E_DATA_DIR!;

/** `vibe-center link` against the running test server; returns the localhost sign-in link. */
export function mintLink(): string {
  const out = execFileSync("bun", ["packages/server/src/cli.ts", "link", "--data-dir", dataDir], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const m = /(http:\/\/localhost:\d+\/login#token=\S+)/.exec(out);
  if (!m?.[1]) throw new Error(`no link in output:\n${out}`);
  return m[1];
}

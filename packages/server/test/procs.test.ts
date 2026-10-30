import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpProcess } from "../src/acp/process.ts";
import { ProcessRegistry } from "../src/procs.ts";

const FAKE_AGENT = join(import.meta.dir, "fake-agent.ts");
const CRASHING_SERVER = join(import.meta.dir, "fixtures/crashing-server.ts");

/** Alive and not a zombie waiting for its reaper. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2)[0] !== "Z";
  } catch {
    return false;
  }
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await Bun.sleep(20);
  }
  return cond();
}

const leftovers: number[] = [];
afterEach(() => {
  for (const pid of leftovers.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
});

async function startStubborn(mode: "child" | "all", registry?: ProcessRegistry) {
  const dir = mkdtempSync(join(tmpdir(), "vc-procs-"));
  const pidFile = join(dir, "child.pid");
  const proc = await AcpProcess.start(
    {
      command: process.execPath,
      args: [FAKE_AGENT],
      env: { FAKE_ACP_STUBBORN: mode, FAKE_ACP_CHILD_PID_FILE: pidFile },
      cwd: dir,
    },
    { onUpdate: () => {}, onPermission: async () => ({ outcome: { outcome: "cancelled" } }) },
    { tracker: registry },
  );
  expect(await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").length > 0)).toBe(true);
  const child = Number(readFileSync(pidFile, "utf8"));
  leftovers.push(proc.pid!, child);
  return { proc, leader: proc.pid!, child };
}

describe.skipIf(process.platform !== "linux")("process groups", () => {
  test("close() kills a child that ignores SIGTERM after its harness exited", async () => {
    const { proc, leader, child } = await startStubborn("child");
    expect(alive(child)).toBe(true);
    const t0 = Date.now();
    await proc.close(300);
    expect(alive(leader)).toBe(false);
    expect(await waitFor(() => !alive(child), 1000)).toBe(true);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  test("close() kills a harness and a child that both ignore SIGTERM", async () => {
    const { proc, leader, child } = await startStubborn("all");
    await proc.close(300);
    expect(alive(leader)).toBe(false);
    expect(await waitFor(() => !alive(child), 1000)).toBe(true);
  });

  test("tracked groups are recorded while they run and forgotten once stopped", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "vc-run-"));
    const registry = new ProcessRegistry(runDir);
    const { proc, leader } = await startStubborn("child", registry);
    expect(readdirSync(runDir)).toEqual([`${leader}.json`]);
    await proc.close(300);
    expect(readdirSync(runDir)).toEqual([]);
  });

  test("the next start reaps what a SIGKILLed server left running", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vc-crash-"));
    const runDir = join(dir, "run");
    const pidFile = join(dir, "child.pid");
    const server = Bun.spawn([process.execPath, CRASHING_SERVER, runDir, pidFile], { stdout: "pipe" });
    leftovers.push(server.pid);
    const reader = server.stdout.getReader();
    const { value } = await reader.read();
    const { leader } = JSON.parse(new TextDecoder().decode(value)) as { leader: number };
    expect(await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").length > 0)).toBe(true);
    const child = Number(readFileSync(pidFile, "utf8"));
    leftovers.push(leader, child);

    server.kill("SIGKILL"); // no cleanup runs
    await server.exited;
    await Bun.sleep(300);
    expect(alive(leader)).toBe(true); // the orphans are still up
    expect(alive(child)).toBe(true);
    expect(readdirSync(runDir)).toEqual([`${leader}.json`]);

    const result = new ProcessRegistry(runDir).reapStale();
    expect(result.records).toBe(1);
    expect(result.killed).toEqual(expect.arrayContaining([leader, child]));
    expect(await waitFor(() => !alive(leader) && !alive(child))).toBe(true);
    expect(readdirSync(runDir)).toEqual([]);
  });

  test("reaping leaves processes alone that don't carry the run's marker", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vc-reuse-"));
    const runDir = join(dir, "run");
    // an unrelated process group whose pgid a stale record happens to name (pid reuse)
    const other = Bun.spawn(["sleep", "30"], { detached: true } as never);
    leftovers.push(other.pid);
    const stale = new ProcessRegistry(runDir);
    stale.track(other.pid, "harness (stale record)");
    const result = new ProcessRegistry(runDir).reapStale();
    expect(result).toEqual({ killed: [], records: 1 });
    expect(alive(other.pid)).toBe(true);
  });
});

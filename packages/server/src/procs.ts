import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Process hygiene for everything the server spawns in its own process group (harnesses, the
 * voice worker, GPU speech jobs):
 *
 * - `stopGroup` stops a whole group: SIGTERM, then SIGKILL to the group after a grace period,
 *   whether or not the leader has exited by then (children that ignore SIGTERM don't survive).
 * - `ProcessRegistry` writes one file per live group under `<data>/run/`. A server that crashes
 *   (SIGKILL, OOM) can't clean up, so the next start reads the files and kills what is left.
 *   Every tracked group gets `VIBE_CENTER_RUN=<run id>` in its env, and only processes that
 *   are in a recorded group *and* carry that run's marker are killed, so a reused pid is never
 *   hit. Reaping reads `/proc` and therefore only works on Linux; elsewhere it just warns.
 */

/** Env var that marks a tracked process (and the children that inherit its env) as this run's. */
export const RUN_ENV = "VIBE_CENTER_RUN";

export interface ProcessTracker {
  /** Env every tracked child gets, so a later start can recognise it and its descendants. */
  readonly env: Record<string, string>;
  /** Record a spawned process group (its leader's pid is the pgid). Returns "forget it". */
  track(pgid: number, label: string): () => void;
}

interface RunRecord {
  runId: string;
  pgid: number;
  label: string;
  startedAt: number;
}

export interface ReapResult {
  /** Process ids that were killed. */
  killed: number[];
  /** Stale records that were read (and removed). */
  records: number;
}

export class ProcessRegistry implements ProcessTracker {
  readonly runId = crypto.randomUUID();
  readonly env: Record<string, string>;

  constructor(private readonly dir: string) {
    this.env = { [RUN_ENV]: this.runId };
  }

  track(pgid: number, label: string): () => void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = join(this.dir, `${pgid}.json`);
    const rec: RunRecord = { runId: this.runId, pgid, label, startedAt: Date.now() };
    writeFileSync(file, JSON.stringify(rec), { mode: 0o600 });
    return () => rmSync(file, { force: true });
  }

  /**
   * Kill the processes an earlier run left behind (it crashed before stopping them). Only call
   * this while no other server uses the data dir (the CLI holds the control socket by then).
   */
  reapStale(): ReapResult {
    let names: string[];
    try {
      names = readdirSync(this.dir).filter((n) => n.endsWith(".json"));
    } catch {
      return { killed: [], records: 0 };
    }
    const records: RunRecord[] = [];
    for (const n of names) {
      const file = join(this.dir, n);
      try {
        const rec = JSON.parse(readFileSync(file, "utf8")) as RunRecord;
        if (rec.runId !== this.runId) records.push(rec);
        else continue;
      } catch {}
      rmSync(file, { force: true });
    }
    const killed: number[] = [];
    if (!records.length) return { killed, records: 0 };
    if (process.platform !== "linux") {
      console.warn(
        `${records.length} process group(s) of a crashed run may still be running (no /proc here)`,
      );
      return { killed, records: records.length };
    }
    const procs = listProcesses();
    for (const rec of records) {
      const ours = procs.filter((p) => p.pgrp === rec.pgid && hasMarker(p.pid, rec.runId));
      if (!ours.length) continue;
      // A marked leader proves the group is ours, members that dropped the env included.
      if (ours.some((p) => p.pid === rec.pgid)) signal(-rec.pgid, "SIGKILL");
      else for (const p of ours) signal(p.pid, "SIGKILL");
      killed.push(...procs.filter((p) => p.pgrp === rec.pgid).map((p) => p.pid));
      console.warn(`killed ${rec.label} (process group ${rec.pgid}) left over from a crashed run`);
    }
    return { killed, records: records.length };
  }
}

/**
 * Stop a process group: SIGTERM to all of it, wait up to `graceMs` for the group to be empty,
 * then SIGKILL whatever is left. Resolves once the group is gone (or after a last second).
 */
export async function stopGroup(pgid: number, graceMs = 2000): Promise<void> {
  if (!groupAlive(pgid)) return;
  signal(-pgid, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (groupAlive(pgid) && Date.now() < deadline) await Bun.sleep(20);
  if (!groupAlive(pgid)) return;
  signal(-pgid, "SIGKILL");
  const last = Date.now() + 1000;
  while (groupAlive(pgid) && Date.now() < last) await Bun.sleep(10);
}

/** True while any process is in the group (zombies awaiting their reaper included). */
export function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signal(target: number, sig: NodeJS.Signals): void {
  try {
    process.kill(target, sig);
  } catch {}
}

function listProcesses(): { pid: number; pgrp: number }[] {
  const out: { pid: number; pgrp: number }[] = [];
  for (const name of readdirSync("/proc")) {
    const pid = Number(name);
    if (!Number.isInteger(pid) || pid === process.pid) continue;
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // pid (comm) state ppid pgrp ...; comm may contain spaces and parentheses
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      out.push({ pid, pgrp: Number(fields[2]) });
    } catch {}
  }
  return out;
}

function hasMarker(pid: number, runId: string): boolean {
  try {
    return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(`${RUN_ENV}=${runId}`);
  } catch {
    return false; // gone, or not ours to read
  }
}

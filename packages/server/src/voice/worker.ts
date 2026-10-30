import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, mkdirSync, renameSync, statSync, type WriteStream } from "node:fs";
import { createServer } from "node:net";
import { dirname } from "node:path";
import { type ProcessTracker, stopGroup } from "../procs.ts";

/**
 * HTTP client for the voice worker's API (services/voice/voice_worker/server.py). Every request
 * carries the worker's Bearer token; the browser never talks to the worker directly.
 */
export class WorkerClient {
  constructor(
    readonly url: string,
    private readonly token: string,
  ) {}

  async request(
    path: string,
    init: RequestInit & { json?: unknown; timeoutMs?: number } = {},
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.token}`);
    if (init.json !== undefined) headers.set("content-type", "application/json");
    return fetch(`${this.url.replace(/\/$/, "")}${path}`, {
      ...init,
      headers,
      body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
      signal: AbortSignal.timeout(init.timeoutMs ?? 10_000),
    });
  }

  async json<T>(path: string, init: Parameters<WorkerClient["request"]>[1] = {}): Promise<T> {
    const res = await this.request(path, init);
    if (!res.ok) throw new WorkerError(res.status, await errorText(res));
    return (await res.json()) as T;
  }
}

export class WorkerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function errorText(res: Response): Promise<string> {
  const body = await res.text().catch(() => "");
  try {
    const detail = (JSON.parse(body) as { detail?: unknown }).detail;
    if (typeof detail === "string") return detail;
  } catch {}
  return body.slice(0, 300) || `${res.status} ${res.statusText}`;
}

export interface WorkerHealth {
  status: "ok" | "loading" | "error";
  error: string | null;
  version: string;
  call: { id: string; stt: string; tts: string } | null;
}

export interface ManagedWorkerOptions {
  /** Command line; the worker reads VC_WORKER_HOST/PORT/TOKEN and VC_VOICE_DATA_DIR. */
  command: string[];
  dataDir: string;
  logFile: string;
  env?: Record<string, string>;
  /** Called on every state change (start, exit, restart scheduled). */
  onChange: () => void;
  /** First restart delay; doubles per consecutive crash up to 30 s. */
  restartDelayMs?: number;
  /** Records the worker's process group so a crashed server's next start can reap it. */
  tracker?: ProcessTracker;
}

const LOG_TAIL = 200;
/** On (re)opening, a log bigger than this moves to `<log>.1` (replacing the previous one). */
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
/** A worker that stayed up this long resets the crash backoff. */
const STABLE_MS = 60_000;

/**
 * The voice worker as a child process of the app (managed mode): spawned in its own process
 * group on a free loopback port with a fresh token, logged to a file, restarted with backoff
 * when it crashes, stopped (SIGTERM, then SIGKILL) with the app.
 */
export class ManagedWorker {
  private child: ChildProcess | null = null;
  private log: WriteStream | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private stopping = false;
  private consecutiveCrashes = 0;
  private startedAt = 0;
  readonly token = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
  port = 0;
  restarts = 0;
  lastExit: string | null = null;
  readonly tail: string[] = [];
  private exited: Promise<void> = Promise.resolve();

  constructor(private readonly opts: ManagedWorkerOptions) {}

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  get running(): boolean {
    return this.child !== null;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get restartPending(): boolean {
    return this.restartTimer !== null;
  }

  client(): WorkerClient {
    return new WorkerClient(this.url, this.token);
  }

  async start(): Promise<void> {
    if (this.child) return;
    this.stopping = false;
    this.port = await freePort();
    mkdirSync(dirname(this.opts.logFile), { recursive: true });
    if (!this.log) {
      rotate(this.opts.logFile);
      this.log = createWriteStream(this.opts.logFile, { flags: "a", mode: 0o600 });
    }
    const [cmd, ...args] = this.opts.command;
    if (!cmd) throw new Error("no voice worker command");
    this.line(`--- starting voice worker on 127.0.0.1:${this.port}: ${this.opts.command.join(" ")}`);
    const child = spawn(cmd, args, {
      detached: true, // own process group: stop() reaches uv's python child too
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ...this.opts.env,
        ...this.opts.tracker?.env,
        VC_WORKER_HOST: "127.0.0.1",
        VC_WORKER_PORT: String(this.port),
        VC_WORKER_TOKEN: this.token,
        VC_VOICE_DATA_DIR: this.opts.dataDir,
      },
    });
    this.child = child;
    this.startedAt = Date.now();
    const untrack = child.pid
      ? (this.opts.tracker?.track(child.pid, "voice worker") ?? (() => {}))
      : () => {};
    const onData = (d: Buffer) => {
      for (const l of d.toString().split("\n")) if (l.trim()) this.line(l);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    this.exited = new Promise((resolve) => {
      child.once("exit", (code, signal) => {
        this.onExit(child, code, signal);
        // uv's python child and anything else in the group go with it
        const done = child.pid ? stopGroup(child.pid, this.stopping ? 5000 : 500) : Promise.resolve();
        void done.finally(() => {
          untrack();
          resolve();
        });
      });
      child.once("error", (e) => {
        this.line(`voice worker failed to start: ${e.message}`);
      });
    });
    console.log(`voice worker started (pid ${child.pid}, port ${this.port})`);
    this.opts.onChange();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const child = this.child;
    // SIGTERM to the group, SIGKILL after 5 s, also to members that outlive the leader
    if (child?.pid) {
      await stopGroup(child.pid, 5000);
      await this.exited;
    }
    this.log?.end();
    this.log = null;
  }

  async restart(): Promise<void> {
    await this.stop();
    this.consecutiveCrashes = 0;
    await this.start();
  }

  private onExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.child !== child) return;
    this.child = null;
    this.lastExit = signal ? `signal ${signal}` : `exit code ${code}`;
    this.line(`--- voice worker exited (${this.lastExit})`);
    if (this.stopping) {
      this.opts.onChange();
      return;
    }
    if (Date.now() - this.startedAt > STABLE_MS) this.consecutiveCrashes = 0;
    const delay = Math.min(30_000, (this.opts.restartDelayMs ?? 1000) * 2 ** this.consecutiveCrashes++);
    console.warn(`voice worker exited (${this.lastExit}); restarting in ${Math.round(delay / 100) / 10} s`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.restarts++;
      void this.start().catch((e) => this.line(`restart failed: ${(e as Error).message}`));
    }, delay);
    this.opts.onChange();
  }

  private line(l: string): void {
    this.log?.write(`${l}\n`);
    this.tail.push(l);
    if (this.tail.length > LOG_TAIL) this.tail.splice(0, this.tail.length - LOG_TAIL);
  }
}

function rotate(file: string): void {
  try {
    if (statSync(file).size > LOG_ROTATE_BYTES) renameSync(file, `${file}.1`);
  } catch {} // no log yet
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

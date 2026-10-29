import { type ChildProcess, spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "./protocol.ts";

export interface LaunchSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
}

export interface ClientHandlers {
  /** Called synchronously, in arrival order, for every `session/update`. */
  onUpdate(notification: acp.SessionNotification): void;
  /** Answer a `session/request_permission`. `signal` aborts if the agent withdraws the request. */
  onPermission(
    request: acp.RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<acp.RequestPermissionResponse>;
  /** Any other notification (harness extensions such as `_auth/status_update`). */
  onOtherNotification?(method: string, params: unknown): void;
}

export interface ExitInfo {
  code: number | null;
  signal: string | null;
}

export class SpawnError extends Error {
  constructor(
    message: string,
    readonly notInstalled: boolean,
  ) {
    super(message);
  }
}

const STDERR_TAIL_LINES = 60;

/**
 * One harness process speaking ACP over stdio: spawn, `initialize`, and teardown. The process
 * runs in its own process group so closing it also stops whatever it spawned (Claude Code's
 * bundled binary, MCP servers).
 */
export class AcpProcess {
  readonly exited: Promise<ExitInfo>;
  private exitInfo: ExitInfo | null = null;
  private stderrLines: string[] = [];

  private constructor(
    private readonly child: ChildProcess,
    private readonly connection: acp.ClientConnection,
    readonly init: acp.InitializeResponse,
    exited: Promise<ExitInfo>,
    stderrLines: string[],
  ) {
    this.exited = exited;
    this.stderrLines = stderrLines;
    void exited.then((info) => {
      this.exitInfo = info;
    });
  }

  get agent(): acp.ClientContext {
    return this.connection.agent;
  }

  get alive(): boolean {
    return this.exitInfo === null;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  stderrTail(lines = 20): string {
    return this.stderrLines.slice(-lines).join("\n");
  }

  static async start(
    spec: LaunchSpec,
    handlers: ClientHandlers,
    opts: { initTimeoutMs?: number; clientName?: string } = {},
  ): Promise<AcpProcess> {
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    const stderrLines: string[] = [];
    let partial = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      const parts = (partial + chunk).split("\n");
      partial = parts.pop() ?? "";
      stderrLines.push(...parts);
      if (stderrLines.length > STDERR_TAIL_LINES)
        stderrLines.splice(0, stderrLines.length - STDERR_TAIL_LINES);
    });

    const exited = new Promise<ExitInfo>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
      child.once("error", () => resolve({ code: null, signal: null }));
    });

    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", (err: NodeJS.ErrnoException) => {
        reject(
          new SpawnError(
            err.code === "ENOENT"
              ? `command not found: ${spec.command}`
              : `failed to start ${spec.command}: ${err.message}`,
            err.code === "ENOENT",
          ),
        );
      });
    });

    const app = acp
      .client({ name: opts.clientName ?? "vibe-center" })
      .onNotification("session/update", ({ params }) => handlers.onUpdate(params))
      .onRequest("session/request_permission", ({ params, signal }) => handlers.onPermission(params, signal))
      .onNotification("*", ({ method, params }) => handlers.onOtherNotification?.(method, params));

    const connection = app.connect(
      acp.ndJsonStream(
        Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
      ),
    );

    const proc = (init: acp.InitializeResponse) =>
      new AcpProcess(child, connection, init, exited, stderrLines);
    const timeoutMs = opts.initTimeoutMs ?? 30_000;
    try {
      const init = await raceExit(
        withTimeout(
          connection.agent.request("initialize", {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
            clientInfo: { name: opts.clientName ?? "vibe-center", version: "0.1.0" },
          }),
          timeoutMs,
          `initialize timed out after ${timeoutMs} ms`,
        ),
        exited,
        () => stderrLines.slice(-10).join("\n"),
      );
      return proc(init);
    } catch (e) {
      connection.close();
      killGroup(child, "SIGKILL");
      throw e;
    }
  }

  /** Close the connection and stop the process group (SIGTERM, then SIGKILL after `graceMs`). */
  async close(graceMs = 2000): Promise<void> {
    this.connection.close();
    if (!this.alive) return;
    killGroup(this.child, "SIGTERM");
    const timer = setTimeout(() => killGroup(this.child, "SIGKILL"), graceMs);
    await this.exited;
    clearTimeout(timer);
  }
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {}
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

class ExitError extends Error {}

/**
 * Rejects as soon as the process exits, with its exit code and stderr tail, instead of waiting
 * for a timeout. A request that fails because the connection closed reports the exit too.
 */
export async function raceExit<T>(p: Promise<T>, exited: Promise<ExitInfo>, tail: () => string): Promise<T> {
  const exitError = (info: ExitInfo) => {
    const detail = tail();
    const how = `code ${info.code ?? "?"}${info.signal ? `, ${info.signal}` : ""}`;
    return new ExitError(`harness exited (${how})${detail ? `:\n${detail}` : ""}`);
  };
  try {
    return await Promise.race([
      p,
      exited.then((info) => {
        throw exitError(info);
      }),
    ]);
  } catch (e) {
    if (e instanceof ExitError || !/connection closed/i.test(String((e as Error)?.message))) throw e;
    // stdout closed just before the exit event: wait briefly so the error names the exit.
    const info = await Promise.race([exited, Bun.sleep(1000).then(() => null)]);
    throw info ? exitError(info) : e;
  }
}

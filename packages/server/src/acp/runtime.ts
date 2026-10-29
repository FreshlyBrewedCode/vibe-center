import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import type { ConfigValues } from "@vibe-center/shared";
import {
  type AdapterAgent,
  type AuthReport,
  type HarnessAdapter,
  type HarnessLaunchConfig,
  launchSpec,
} from "./adapters/index.ts";
import { configChanges, setConfigParams } from "./config-options.ts";
import type { McpProvider } from "./mcp.ts";
import { AcpProcess, raceExit, withTimeout } from "./process.ts";
import * as acp from "./protocol.ts";

export type RuntimePresence = "idle" | "thinking" | "working" | "waiting" | "error";

export interface TurnResult {
  status: "complete" | "cancelled" | "error";
  stopReason: acp.StopReason | null;
  error: string | null;
}

export type PermissionOutcome = { optionId: string } | "cancelled";

export type RuntimeEvent =
  | {
      type: "session.ready";
      sessionKey: string;
      acpSessionId: string;
      resumed: boolean;
      /** Set when an existing ACP session could not be resumed and a fresh one was created. */
      resumeFailed: string | null;
      configOptions: acp.SessionConfigOption[];
      /** Desired model/options the harness didn't accept. */
      configWarnings: string[];
    }
  /** Session-level updates outside of turn content: commands, mode, config, session info. */
  | { type: "session.update"; sessionKey: string; update: acp.SessionUpdate }
  | { type: "turn.start"; turnId: string }
  | { type: "turn.update"; turnId: string; update: acp.SessionUpdate }
  | { type: "permission.request"; turnId: string; requestId: string; request: acp.RequestPermissionRequest }
  | { type: "permission.resolved"; turnId: string; requestId: string; outcome: PermissionOutcome }
  /** Every prompt() gets exactly one turn.end, also when it was cancelled while queued. */
  | { type: "turn.end"; turnId: string; result: TurnResult }
  | { type: "presence"; presence: RuntimePresence; detail: string | null }
  | { type: "auth"; report: AuthReport }
  | { type: "process.exit"; code: number | null; signal: string | null; stderr: string };

export interface PromptInput {
  /** Caller-chosen id (the domain uses its DB turn id). */
  turnId: string;
  content: acp.ContentBlock[];
  /**
   * Hidden text sent to the harness before the content, not shown as a message: the voice-mode
   * note (phase 2b), framing for agent-to-agent events (phase 2a).
   */
  note?: string;
  /** Overrides the idle timeout for this prompt (e.g. short for voice turns). */
  idleTimeoutMs?: number;
}

export interface RuntimeTimeouts {
  /** Cancel a turn after this long without any session/update (no tool running). */
  idleMs: number;
  /** Same while a tool call is in progress (builds and test runs are quiet). */
  toolIdleMs: number;
  /** After session/cancel, how long the harness gets to end the turn before it is restarted. */
  cancelGraceMs: number;
  initMs: number;
  sessionMs: number;
}

export const DEFAULT_TIMEOUTS: RuntimeTimeouts = {
  idleMs: 120_000,
  toolIdleMs: 30 * 60_000,
  cancelGraceMs: 5_000,
  initMs: 30_000,
  sessionMs: 60_000,
};

export interface RuntimeConfig {
  agent: AdapterAgent;
  /** Harness config option values other than the model (mode, effort, ...). */
  options: ConfigValues;
  harness: HarnessLaunchConfig;
  adapter: HarnessAdapter;
}

export interface RuntimeOptions extends RuntimeConfig {
  mcp: McpProvider;
  /** The app session to use and, if it has one, the ACP session id to resume. */
  session: { key: string; acpSessionId: string | null };
  onEvent: (event: RuntimeEvent) => void;
  timeouts?: Partial<RuntimeTimeouts>;
}

interface ActiveTurn {
  turnId: string;
  sessionId: string | null;
  idleMs: number;
  lastActivity: number;
  openTools: Map<string, string>;
  permissions: Map<string, { title: string; done: (outcome: PermissionOutcome) => void }>;
  cancelReason: null | "user" | "timeout";
  abandon: (err: Error) => void;
  abandoned: Promise<never>;
  timers: ReturnType<typeof setTimeout>[];
}

class TurnCancelled extends Error {}

/**
 * Everything one agent's harness does, behind a small API: prompt, cancel, newSession,
 * respondPermission, reconfigure. One process and at most one live ACP session per agent;
 * prompts are queued and run one at a time. The process is spawned lazily on the first prompt
 * and respawned (resuming the ACP session) after a crash or a hung cancel.
 *
 * Knows nothing about storage or HTTP: callers turn RuntimeEvents into messages.
 */
export class AgentRuntime {
  private cfg: RuntimeConfig;
  private readonly timeouts: RuntimeTimeouts;
  private proc: AcpProcess | null = null;
  private starting: Promise<AcpProcess> | null = null;
  private sessionKey: string;
  private acpSessionId: string | null = null;
  /** ACP session to resume when the next session is set up (survives process restarts). */
  private resumeTarget: string | null;
  private replaying: string | null = null;
  private preamblePending = false;
  private configDirty = false;
  private relaunchPending = false;
  private configOptions: acp.SessionConfigOption[] = [];
  private queue: { input: PromptInput; resolve: (r: TurnResult) => void }[] = [];
  private current: ActiveTurn | null = null;
  private draining: Promise<void> | null = null;
  private lastError: string | null = null;
  private presenceState: { presence: RuntimePresence; detail: string | null } = {
    presence: "idle",
    detail: null,
  };
  private disposed = false;

  constructor(private readonly opts: RuntimeOptions) {
    this.cfg = { agent: opts.agent, options: opts.options, harness: opts.harness, adapter: opts.adapter };
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...opts.timeouts };
    this.sessionKey = opts.session.key;
    this.resumeTarget = opts.session.acpSessionId;
  }

  get presence(): { presence: RuntimePresence; detail: string | null } {
    return this.presenceState;
  }

  /** True while a turn is running or queued. */
  get busy(): boolean {
    return this.current !== null || this.queue.length > 0;
  }

  get currentTurnId(): string | null {
    return this.current?.turnId ?? null;
  }

  get pid(): number | undefined {
    return this.proc?.alive ? this.proc.pid : undefined;
  }

  /** Last config options the live session reported (models, modes, ...). */
  get sessionConfigOptions(): acp.SessionConfigOption[] {
    return this.configOptions;
  }

  /** Queue a prompt. Resolves when its turn ends; events arrive through onEvent meanwhile. */
  prompt(input: PromptInput): { turnId: string; done: Promise<TurnResult> } {
    if (this.disposed) throw new Error("runtime disposed");
    const done = new Promise<TurnResult>((resolve) => this.queue.push({ input, resolve }));
    void this.drain();
    return { turnId: input.turnId, done };
  }

  /** Stop the running turn and drop queued ones. Returns once the running turn has ended. */
  async cancel(): Promise<void> {
    for (const q of this.queue.splice(0)) this.endQueued(q, "cancelled before it started");
    if (this.current) this.cancelTurn(this.current, "user");
    await this.draining;
  }

  /** End the current ACP session; the next prompt starts a fresh one under `sessionKey`. */
  async newSession(sessionKey: string): Promise<void> {
    await this.cancel();
    const old = this.acpSessionId;
    this.sessionKey = sessionKey;
    this.acpSessionId = null;
    this.resumeTarget = null;
    const proc = this.proc;
    if (old && proc?.alive && proc.init.agentCapabilities?.sessionCapabilities?.close) {
      void proc.agent.request("session/close", { sessionId: old }).catch(() => {});
    }
  }

  /** Answer a pending permission request of the running turn. */
  respondPermission(requestId: string, optionId: string): boolean {
    const p = this.current?.permissions.get(requestId);
    if (!p) return false;
    p.done({ optionId });
    return true;
  }

  /**
   * Apply a changed agent/harness config. Model and options are set on the live session before
   * the next prompt; launch changes (harness, cwd, persona) restart the process once idle, and
   * the ACP session is resumed so the conversation keeps its context.
   */
  reconfigure(next: RuntimeConfig): void {
    const prev = this.cfg;
    this.cfg = next;
    const launchChanged =
      JSON.stringify(prev.harness) !== JSON.stringify(next.harness) ||
      prev.adapter.kind !== next.adapter.kind ||
      prev.agent.cwd !== next.agent.cwd ||
      prev.agent.systemPrompt !== next.agent.systemPrompt;
    if (launchChanged) {
      this.relaunchPending = true;
      if (!this.busy) void this.relaunchIfPending();
    }
    if (
      prev.agent.model !== next.agent.model ||
      JSON.stringify(prev.options) !== JSON.stringify(next.options)
    ) {
      this.configDirty = true;
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const q of this.queue.splice(0)) this.endQueued(q, "agent stopped");
    if (this.current) this.cancelTurn(this.current, "user");
    const proc = this.proc ?? (await this.starting?.catch(() => null)) ?? null;
    this.proc = null;
    await proc?.close();
  }

  // ---- turn loop ------------------------------------------------------------------------------

  private drain(): Promise<void> {
    if (this.draining) return this.draining;
    this.draining = (async () => {
      try {
        while (!this.disposed) {
          const item = this.queue.shift();
          if (item) {
            item.resolve(await this.runTurn(item.input));
            continue;
          }
          await this.relaunchIfPending();
          // A prompt may have been queued while we awaited; only stop when the queue is empty
          // with no await in between, so nothing can slip past the loop.
          if (!this.queue.length) break;
        }
      } finally {
        this.draining = null;
      }
    })();
    return this.draining;
  }

  private endQueued(q: { input: PromptInput; resolve: (r: TurnResult) => void }, error: string): void {
    const result: TurnResult = { status: "cancelled", stopReason: null, error };
    this.emit({ type: "turn.end", turnId: q.input.turnId, result });
    q.resolve(result);
  }

  private async runTurn(input: PromptInput): Promise<TurnResult> {
    let abandon!: (err: Error) => void;
    const abandoned = new Promise<never>((_, reject) => {
      abandon = reject;
    });
    abandoned.catch(() => {});
    const turn: ActiveTurn = {
      turnId: input.turnId,
      sessionId: null,
      idleMs: input.idleTimeoutMs ?? this.timeouts.idleMs,
      lastActivity: Date.now(),
      openTools: new Map(),
      permissions: new Map(),
      cancelReason: null,
      abandon,
      abandoned,
      timers: [],
    };
    this.current = turn;
    this.lastError = null;
    this.emit({ type: "turn.start", turnId: turn.turnId });
    this.refreshPresence();

    let result: TurnResult;
    try {
      await this.relaunchIfPending();
      const proc = await Promise.race([this.ensureProcess(), abandoned]);
      const sessionId = await Promise.race([this.ensureSession(proc), abandoned]);
      if (turn.cancelReason) throw new TurnCancelled();
      turn.sessionId = sessionId;
      turn.lastActivity = Date.now();
      this.watchIdle(turn);
      const res = await raceExit(
        Promise.race([
          proc.agent.request("session/prompt", { sessionId, prompt: this.buildPrompt(input) }),
          abandoned,
        ]),
        proc.exited,
        () => proc.stderrTail(10),
      );
      result = this.resultFor(turn, res.stopReason);
    } catch (e) {
      result = this.errorResult(turn, e);
    } finally {
      for (const t of turn.timers) clearTimeout(t);
      for (const p of [...turn.permissions.values()]) p.done("cancelled");
      this.current = null;
    }
    if (result.status === "error") this.lastError = result.error;
    this.emit({ type: "turn.end", turnId: turn.turnId, result });
    this.refreshPresence();
    return result;
  }

  private resultFor(turn: ActiveTurn, stopReason: acp.StopReason): TurnResult {
    if (turn.cancelReason === "timeout") {
      return { status: "error", stopReason, error: this.timeoutMessage(turn) };
    }
    // OpenCode answers a cancel of a hung prompt with end_turn, so trust our own flag too.
    if (stopReason === "cancelled" || turn.cancelReason === "user") {
      return { status: "cancelled", stopReason: "cancelled", error: null };
    }
    return { status: "complete", stopReason, error: null };
  }

  private errorResult(turn: ActiveTurn, e: unknown): TurnResult {
    if (turn.cancelReason === "user") return { status: "cancelled", stopReason: null, error: null };
    if (turn.cancelReason === "timeout")
      return { status: "error", stopReason: null, error: this.timeoutMessage(turn) };
    return { status: "error", stopReason: null, error: describeError(e) };
  }

  private timeoutMessage(turn: ActiveTurn): string {
    const limit = turn.openTools.size ? this.timeouts.toolIdleMs : turn.idleMs;
    const human = limit >= 10_000 ? `${Math.round(limit / 1000)} s` : `${(limit / 1000).toFixed(1)} s`;
    return `No response from the harness for ${human}, so the turn was cancelled.`;
  }

  private buildPrompt(input: PromptInput): acp.ContentBlock[] {
    const blocks: acp.ContentBlock[] = [];
    if (this.preamblePending) {
      this.preamblePending = false;
      blocks.push({
        type: "text",
        text: `<system-instructions>\n${this.cfg.agent.systemPrompt}\n</system-instructions>`,
      });
    }
    if (input.note) blocks.push({ type: "text", text: input.note });
    blocks.push(...input.content);
    return blocks;
  }

  private cancelTurn(turn: ActiveTurn, reason: "user" | "timeout"): void {
    if (turn.cancelReason) return;
    turn.cancelReason = reason;
    // ACP: the client must answer pending permission requests with `cancelled` on cancel.
    for (const p of [...turn.permissions.values()]) p.done("cancelled");
    const proc = this.proc;
    if (!turn.sessionId || !proc?.alive) {
      turn.abandon(new TurnCancelled());
      return;
    }
    void proc.agent.notify("session/cancel", { sessionId: turn.sessionId }).catch(() => {});
    turn.timers.push(
      setTimeout(() => {
        if (this.current !== turn) return;
        // The harness ignored the cancel (seen with OpenCode on provider errors): stop waiting
        // and restart it before the next prompt. The ACP session is resumed then.
        turn.abandon(new Error("the harness did not stop after cancel; it will be restarted"));
        this.proc = null;
        this.acpSessionId = null;
        void proc.close(500);
      }, this.timeouts.cancelGraceMs),
    );
  }

  private watchIdle(turn: ActiveTurn): void {
    const tick = Math.max(20, Math.min(1000, Math.floor(turn.idleMs / 4)));
    const check = () => {
      if (this.current !== turn || turn.cancelReason) return;
      const limit = turn.permissions.size
        ? Number.POSITIVE_INFINITY
        : turn.openTools.size
          ? this.timeouts.toolIdleMs
          : turn.idleMs;
      if (Date.now() - turn.lastActivity >= limit) {
        this.cancelTurn(turn, "timeout");
        return;
      }
      turn.timers.push(setTimeout(check, tick));
    };
    turn.timers.push(setTimeout(check, tick));
  }

  // ---- process and session --------------------------------------------------------------------

  private async relaunchIfPending(): Promise<void> {
    if (!this.relaunchPending) return;
    this.relaunchPending = false;
    const proc = this.proc;
    this.proc = null;
    this.acpSessionId = null;
    await proc?.close();
  }

  private ensureProcess(): Promise<AcpProcess> {
    if (this.proc?.alive) return Promise.resolve(this.proc);
    if (!this.starting) {
      this.starting = this.spawn().finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  private async spawn(): Promise<AcpProcess> {
    const { agent, adapter, harness } = this.cfg;
    if (!existsSync(agent.cwd)) throw new Error(`working directory does not exist: ${agent.cwd}`);
    await mkdir(agent.stateDir, { recursive: true });
    const { env } = await adapter.prepareProcess(agent);
    const proc = await AcpProcess.start(
      launchSpec(harness, agent.cwd, env),
      {
        onUpdate: (n) => this.onUpdate(n),
        onPermission: (req, signal) => this.onPermission(req, signal),
        onOtherNotification: (method, params) => {
          const report = adapter.readAuth?.(method, params);
          if (report) this.emit({ type: "auth", report });
        },
      },
      { initTimeoutMs: this.timeouts.initMs },
    );
    if (this.disposed) {
      await proc.close();
      throw new Error("runtime disposed");
    }
    this.proc = proc;
    this.acpSessionId = null;
    void proc.exited.then((info) => {
      if (this.proc !== proc) return; // replaced or closed on purpose
      this.proc = null;
      this.acpSessionId = null;
      this.emit({ type: "process.exit", code: info.code, signal: info.signal, stderr: proc.stderrTail() });
      if (!this.current && !this.disposed) {
        this.lastError = `harness exited unexpectedly (code ${info.code ?? "?"})`;
        this.refreshPresence();
      }
    });
    return proc;
  }

  private async ensureSession(proc: AcpProcess): Promise<string> {
    if (this.acpSessionId) {
      if (this.configDirty) await this.applyConfig(proc, this.acpSessionId, []);
      return this.acpSessionId;
    }
    const { agent, adapter } = this.cfg;
    const caps = proc.init.agentCapabilities ?? {};
    const mcp = await this.opts.mcp.forSession({
      agentId: agent.agentId,
      sessionKey: this.sessionKey,
      capabilities: caps,
    });
    const ctx = { ...agent, capabilities: caps, mcp };
    const base: acp.NewSessionRequest = {
      cwd: agent.cwd,
      mcpServers: mcp.servers,
      ...adapter.sessionFields(ctx),
    };
    const timed = <T>(p: Promise<T>, what: string) =>
      raceExit(withTimeout(p, this.timeouts.sessionMs, `${what} timed out`), proc.exited, () =>
        proc.stderrTail(10),
      );

    const target = this.resumeTarget;
    let sessionId: string | null = null;
    let configOptions: acp.SessionConfigOption[] = [];
    let resumeFailed: string | null = null;
    if (target) {
      try {
        if (caps.sessionCapabilities?.resume) {
          const r = await timed(
            proc.agent.request("session/resume", { ...base, sessionId: target }),
            "session/resume",
          );
          configOptions = r.configOptions ?? [];
          sessionId = target;
        } else if (caps.loadSession) {
          // session/load replays the history as session/update; we already have it, so drop it.
          this.replaying = target;
          const r = await timed(
            proc.agent.request("session/load", { ...base, sessionId: target }),
            "session/load",
          );
          configOptions = r?.configOptions ?? [];
          sessionId = target;
        } else {
          resumeFailed = "the harness cannot resume sessions";
        }
      } catch (e) {
        resumeFailed = describeError(e);
      } finally {
        this.replaying = null;
      }
    }
    const resumed = sessionId !== null;
    if (!sessionId) {
      const r = await timed(proc.agent.request("session/new", base), "session/new");
      sessionId = r.sessionId;
      configOptions = r.configOptions ?? [];
    }
    this.acpSessionId = sessionId;
    this.resumeTarget = sessionId;
    this.configOptions = configOptions;
    this.preamblePending = !resumed && adapter.needsPromptPreamble(ctx);
    const warnings: string[] = [];
    await this.applyConfig(proc, sessionId, warnings);
    this.emit({
      type: "session.ready",
      sessionKey: this.sessionKey,
      acpSessionId: sessionId,
      resumed,
      resumeFailed: target && !resumed ? resumeFailed : null,
      configOptions: this.configOptions,
      configWarnings: warnings,
    });
    return sessionId;
  }

  private async applyConfig(proc: AcpProcess, sessionId: string, warnings: string[]): Promise<void> {
    this.configDirty = false;
    const { changes, skipped } = configChanges(this.configOptions, {
      model: this.cfg.agent.model,
      options: this.cfg.options,
    });
    warnings.push(...skipped);
    for (const change of changes) {
      try {
        const r = await proc.agent.request("session/set_config_option", setConfigParams(sessionId, change));
        this.configOptions = r.configOptions;
      } catch (e) {
        warnings.push(`${change.configId}: ${describeError(e)}`);
      }
    }
  }

  // ---- inbound ACP ----------------------------------------------------------------------------

  private onUpdate(n: acp.SessionNotification): void {
    if (this.replaying && n.sessionId === this.replaying) return;
    if (n.sessionId !== this.acpSessionId) return;
    const u = n.update;
    if (
      u.sessionUpdate === "available_commands_update" ||
      u.sessionUpdate === "current_mode_update" ||
      u.sessionUpdate === "config_option_update" ||
      u.sessionUpdate === "session_info_update"
    ) {
      if (u.sessionUpdate === "config_option_update") this.configOptions = u.configOptions;
      this.emit({ type: "session.update", sessionKey: this.sessionKey, update: u });
      return;
    }
    const turn = this.current;
    if (!turn || turn.sessionId !== n.sessionId) return; // e.g. a straggler after the turn ended
    turn.lastActivity = Date.now();
    if (u.sessionUpdate === "tool_call") {
      if (u.status !== "completed" && u.status !== "failed") turn.openTools.set(u.toolCallId, u.title);
    } else if (u.sessionUpdate === "tool_call_update") {
      if (u.status === "completed" || u.status === "failed") turn.openTools.delete(u.toolCallId);
      else if (u.title && turn.openTools.has(u.toolCallId)) turn.openTools.set(u.toolCallId, u.title);
      else if (u.status === "in_progress" || u.status === "pending")
        turn.openTools.set(u.toolCallId, u.title ?? turn.openTools.get(u.toolCallId) ?? "tool");
    }
    this.emit({ type: "turn.update", turnId: turn.turnId, update: u });
    this.refreshPresence();
  }

  private onPermission(
    req: acp.RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<acp.RequestPermissionResponse> {
    const turn = this.current;
    if (!turn || turn.cancelReason || req.sessionId !== turn.sessionId) {
      return Promise.resolve({ outcome: { outcome: "cancelled" } });
    }
    const requestId = Bun.randomUUIDv7();
    turn.lastActivity = Date.now();
    return new Promise((resolve) => {
      const done = (outcome: PermissionOutcome) => {
        if (!turn.permissions.delete(requestId)) return;
        turn.lastActivity = Date.now();
        resolve(
          outcome === "cancelled"
            ? { outcome: { outcome: "cancelled" } }
            : { outcome: { outcome: "selected", optionId: outcome.optionId } },
        );
        this.emit({ type: "permission.resolved", turnId: turn.turnId, requestId, outcome });
        this.refreshPresence();
      };
      turn.permissions.set(requestId, { title: req.toolCall.title ?? "permission", done });
      signal.addEventListener("abort", () => done("cancelled"), { once: true });
      this.emit({ type: "permission.request", turnId: turn.turnId, requestId, request: req });
      this.refreshPresence();
    });
  }

  // ---- presence -------------------------------------------------------------------------------

  private refreshPresence(): void {
    const next = this.computePresence();
    if (next.presence === this.presenceState.presence && next.detail === this.presenceState.detail) return;
    this.presenceState = next;
    this.emit({ type: "presence", ...next });
  }

  private computePresence(): { presence: RuntimePresence; detail: string | null } {
    const t = this.current;
    if (t) {
      const perm = [...t.permissions.values()][0];
      if (perm) return { presence: "waiting", detail: perm.title };
      const tool = [...t.openTools.values()].at(-1);
      if (tool) return { presence: "working", detail: tool };
      return { presence: "thinking", detail: null };
    }
    if (this.lastError) return { presence: "error", detail: this.lastError };
    return { presence: "idle", detail: null };
  }

  private emit(event: RuntimeEvent): void {
    try {
      this.opts.onEvent(event);
    } catch (e) {
      console.error("runtime event handler failed", e);
    }
  }
}

export function describeError(e: unknown): string {
  if (e instanceof acp.RequestError) {
    const data = e.data as { details?: unknown } | undefined;
    const details = typeof data?.details === "string" ? `: ${data.details}` : "";
    if (e.code === -32000) return `authentication required${details || `: ${e.message}`}`;
    return `${e.message}${details}`;
  }
  if (e instanceof Error) return e.message;
  return String(e);
}

import type { Watch, WatchKind, WatchStatus } from "@vibe-center/shared";
import { watchPaths } from "@vibe-center/shared";
import type { Repos } from "../db/repos/index.ts";
import { toWatch, type WatchRecord } from "../db/repos/watches.ts";
import type { EventBus } from "../events/bus.ts";
import type { ChatService, PromptHandle, PromptRequest } from "./chat.ts";
import { HttpError } from "./errors.ts";

/**
 * Background waits. Instead of blocking a turn, an agent registers a watch (a timer, a tool call
 * the app runs in the background, another agent's reply, a webhook) with a note on why it cares.
 * The app does the waiting; when the watch fires, the event goes into the agent's inbox and the
 * inbox starts a new `event` turn:
 *
 * - agent idle: at once;
 * - agent busy (a turn running or queued, e.g. you are talking to it): after its last turn ends,
 *   with everything that fired meanwhile combined into one prompt;
 * - in a call: handed to the call (`speakEvent`), which prompts once nobody is talking and the
 *   agent is idle; it never talks over you, and a barge-in works as usual.
 *
 * Watches are rows (`watches`), owned by the agent, not its session: timers and webhooks survive
 * a restart; a background tool call or an agent reply can't (the call and the turn are gone), so
 * those fire with "interrupted by a restart" when the app starts again.
 */

export const WATCH_LIMITS = {
  /** Active watches per agent (agent replies have their own limit in the messenger). */
  active: 10,
  /** Watch firings that led to the turn registering a new watch: stops self-feeding chains. */
  depth: 10,
  /** Webhook requests per agent per hour that start a turn; more get 429. */
  webhookPerHour: 30,
  /** Longest timer / expiry. */
  maxMs: 30 * 24 * 60 * 60_000,
  /** Default expiry of a background tool call or a webhook. */
  defaultExpiryMs: 24 * 60 * 60_000,
  /** Text of one event handed to the agent. */
  textChars: 8000,
  /** Webhook bodies read at most. */
  bodyBytes: 64 * 1024,
} as const;

/** An event fired later than this is delivered with its age, so the agent can judge relevance. */
const STALE_MS = 60_000;
/** While events wait for a busy agent, check this often in case a turn end was missed. */
const RETRY_MS = 1000;

/** The background tool calls the gateway runs for `call_in_background`. */
export interface BackgroundTools {
  /** Validates that the agent may call it; throws an Error with a message for the agent. */
  resolve(
    agentId: string,
    name: string,
  ): {
    label: string;
    run(
      args: Record<string, unknown>,
      o: { timeoutMs: number; signal: AbortSignal },
    ): Promise<{ text: string; isError: boolean }>;
  };
}

export type SpeakEvent = (
  agentId: string,
  text: string,
  opts: {
    note?: string;
    fromAgentId?: string | null;
    watch?: PromptRequest["watch"];
    onPrompt?: (h: PromptHandle) => void;
  },
) => boolean;

export interface WatchDeps {
  repos: Repos;
  bus: EventBus;
  chat: ChatService;
  /** Phase 2b: deliver into a running call with the agent. */
  speakEvent?: SpeakEvent;
  tools?: BackgroundTools;
}

/** What a firing hands to the inbox. */
interface Fired {
  watch: WatchRecord;
  text: string;
  firedAt: number;
  /** Replaces the generic "a watch fired" note (agent replies have their own). */
  note?: string;
  fromAgentId?: string | null;
  onPrompt?: (h: PromptHandle) => void;
}

export interface RegisterInput {
  agentId: string;
  /** The turn the agent registered it in (for the chain depth). */
  turnId: string | null;
  note: string;
}

const sha256 = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function ago(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 36 ? `${h} h` : `${Math.round(h / 24)} days`;
}

export class WatchService {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private calls = new Map<string, AbortController>();
  private inbox = new Map<string, Fired[]>();
  private retry = new Map<string, ReturnType<typeof setTimeout>>();
  /** Chain depth of event turns this service started (turn id → depth). */
  private turnDepth = new Map<string, number>();
  private webhookHits = new Map<string, number[]>();
  private baseUrl: string | null = null;
  private publicUrl: string | null = null;
  private stopped = false;
  private readonly unsubscribe: (() => void)[] = [];

  constructor(private readonly d: WatchDeps) {
    this.unsubscribe.push(
      d.chat.onTurnEnd((agentId, turnId) => {
        // the depth only matters while the turn can still register watches
        this.turnDepth.delete(turnId);
        if (this.inbox.has(agentId)) queueMicrotask(() => this.flush(agentId));
      }),
      d.bus.subscribe((e) => {
        if (e.type === "agent.deleted") this.forgetAgent(e.agentId);
      }),
    );
  }

  /** Arm timers and expiries of stored watches; report the ones a restart broke. */
  start(): void {
    for (const w of this.d.repos.watches.active()) {
      if (w.kind === "tool" || w.kind === "agent_reply") {
        const what = w.kind === "tool" ? "The background call" : "The message's turn";
        this.fire(w.id, `${what} was interrupted by a restart of the app; it has no result.`, {
          status: "failed",
        });
      } else {
        this.arm(w);
      }
    }
  }

  /** Where webhooks are reached: the loopback URL, and the tailnet one once published. */
  setUrls(urls: { base?: string; public?: string | null }): void {
    if (urls.base !== undefined) this.baseUrl = urls.base.replace(/\/$/, "");
    if (urls.public !== undefined) this.publicUrl = urls.public?.replace(/\/$/, "") ?? null;
  }

  stop(): void {
    this.stopped = true;
    for (const u of this.unsubscribe) u();
    for (const t of this.timers.values()) clearTimeout(t);
    for (const t of this.retry.values()) clearTimeout(t);
    for (const c of this.calls.values()) c.abort();
    this.timers.clear();
    this.retry.clear();
    this.calls.clear();
  }

  // ---- queries ----------------------------------------------------------------------------------

  list(agentId: string): Watch[] {
    return this.d.repos.watches.forAgent(agentId).map(toWatch);
  }

  get(id: string): Watch | null {
    const w = this.d.repos.watches.get(id);
    return w ? toWatch(w) : null;
  }

  // ---- registering ------------------------------------------------------------------------------

  timer(input: RegisterInput & { fireAt: number; label?: string }): Watch {
    const now = Date.now();
    if (!Number.isFinite(input.fireAt) || input.fireAt < now - 1000) {
      throw new HttpError(400, "the time is in the past");
    }
    if (input.fireAt - now > WATCH_LIMITS.maxMs) throw new HttpError(400, "at most 30 days ahead");
    const w = this.insert(input, {
      kind: "timer",
      label:
        input.label?.trim() ||
        `Timer: ${new Date(input.fireAt).toISOString().slice(0, 16).replace("T", " ")} UTC`,
      fireAt: input.fireAt,
    });
    this.arm(w);
    return toWatch(w);
  }

  /** Run one of the agent's upstream tools in the background; its result fires the watch. */
  tool(input: RegisterInput & { tool: string; args: Record<string, unknown>; timeoutMs?: number }): Watch {
    if (!this.d.tools) throw new HttpError(400, "background tool calls are not available");
    let resolved: ReturnType<BackgroundTools["resolve"]>;
    try {
      resolved = this.d.tools.resolve(input.agentId, input.tool);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    const timeoutMs = Math.min(input.timeoutMs ?? WATCH_LIMITS.defaultExpiryMs, WATCH_LIMITS.maxMs);
    const w = this.insert(input, {
      kind: "tool",
      label: resolved.label,
      spec: { tool: input.tool, args: input.args, timeoutMs },
      expiresAt: Date.now() + timeoutMs,
    });
    const abort = new AbortController();
    this.calls.set(w.id, abort);
    void resolved
      .run(input.args, { timeoutMs, signal: abort.signal })
      .then(
        (r) =>
          r.isError
            ? `${resolved.label} returned an error:\n${r.text}`
            : `${resolved.label} finished:\n${r.text}`,
        (e) => `${resolved.label} failed: ${(e as Error).message ?? String(e)}`,
      )
      .then((text) => {
        this.calls.delete(w.id);
        if (!abort.signal.aborted) this.fire(w.id, text);
      });
    this.arm(w);
    return toWatch(w);
  }

  /** A webhook URL; a request to it fires the watch (every request, with `repeat`). */
  webhook(input: RegisterInput & { expiresInMs?: number; repeat?: boolean; label?: string }): {
    watch: Watch;
    urls: string[];
  } {
    const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
    const ttl = Math.min(input.expiresInMs ?? WATCH_LIMITS.defaultExpiryMs, WATCH_LIMITS.maxMs);
    const w = this.insert(input, {
      kind: "webhook",
      label: input.label?.trim() || "Webhook",
      expiresAt: Date.now() + ttl,
      repeat: !!input.repeat,
      secretHash: sha256(secret),
    });
    this.arm(w);
    const path = watchPaths.hook(w.id, secret);
    const urls = [this.publicUrl, this.baseUrl].filter((u): u is string => !!u).map((u) => `${u}${path}`);
    return { watch: toWatch(w), urls };
  }

  /**
   * The agent messaged another agent (send_message_to_agent): wait for that turn's reply. The
   * messenger fires it with the reply (`fire`), so it goes through the same inbox.
   */
  agentReply(input: RegisterInput & { toAgentId: string; toName: string }): Watch {
    const w = this.insert(
      input,
      { kind: "agent_reply", label: `Reply from ${input.toName}`, spec: { toAgentId: input.toAgentId } },
      { skipLimit: true },
    );
    return toWatch(w);
  }

  /** The chain depth a watch registered in this turn gets; throws past the limit. */
  private depthFor(turnId: string | null): number {
    const depth = turnId ? (this.turnDepth.get(turnId) ?? 0) : 0;
    if (depth >= WATCH_LIMITS.depth) {
      throw new HttpError(
        429,
        `not registered: ${depth} watches in a row have fired into each other (limit ${WATCH_LIMITS.depth}). Finish with what you have, or ask the user.`,
      );
    }
    return depth;
  }

  private insert(
    input: RegisterInput,
    w: {
      kind: WatchKind;
      label: string;
      spec?: Record<string, unknown>;
      fireAt?: number;
      expiresAt?: number;
      repeat?: boolean;
      secretHash?: string;
    },
    opts: { skipLimit?: boolean } = {},
  ): WatchRecord {
    if (this.stopped) throw new HttpError(503, "the app is shutting down");
    if (!this.d.repos.agents.get(input.agentId)) throw new HttpError(404, "unknown agent");
    const depth = this.depthFor(input.turnId);
    if (!opts.skipLimit) {
      const n = this.d.repos.watches.countActive(input.agentId);
      if (n >= WATCH_LIMITS.active) {
        throw new HttpError(
          429,
          `not registered: you have ${n} active watches (limit ${WATCH_LIMITS.active}). Cancel one you no longer need (list_watches, cancel_watch).`,
        );
      }
    }
    const rec = this.d.repos.watches.insert({
      agentId: input.agentId,
      note: input.note.trim(),
      depth,
      ...w,
    });
    this.publish(rec);
    return rec;
  }

  // ---- ending -----------------------------------------------------------------------------------

  /** Cancel an active watch (the agent's cancel_watch, or the UI). The agent isn't prompted. */
  cancel(id: string, agentId?: string): Watch {
    const cur = this.d.repos.watches.get(id);
    if (!cur || (agentId && cur.agentId !== agentId)) throw new HttpError(404, `no watch with id ${id}`);
    if (cur.status !== "active") throw new HttpError(409, `the watch is already ${cur.status}`);
    const w = this.d.repos.watches.settle(id, "cancelled", null);
    this.disarm(id);
    if (w) this.publish(w);
    return toWatch(w ?? cur);
  }

  /**
   * The watch fired (or ended otherwise, with `status`): record it and queue `text` for the
   * agent. A repeating webhook stays active. Returns false if it wasn't active any more.
   */
  fire(
    id: string,
    text: string,
    opts: {
      status?: Exclude<WatchStatus, "active" | "cancelled">;
      note?: string;
      fromAgentId?: string | null;
      onPrompt?: (h: PromptHandle) => void;
    } = {},
  ): boolean {
    const cur = this.d.repos.watches.get(id);
    if (!cur) return false;
    const status = opts.status ?? (cur.repeat ? "active" : "fired");
    const w = this.d.repos.watches.settle(id, status, clip(text, 500));
    if (!w) return false;
    if (status !== "active") this.disarm(id);
    this.publish(w);
    this.enqueue({
      watch: w,
      text: clip(text, WATCH_LIMITS.textChars),
      firedAt: Date.now(),
      note: opts.note,
      fromAgentId: opts.fromAgentId,
      onPrompt: opts.onPrompt,
    });
    return true;
  }

  // ---- webhooks ---------------------------------------------------------------------------------

  /** `POST /hooks/w/<id>/<secret>`: no cookie; the secret in the path is the credential. */
  async handleWebhook(req: Request): Promise<Response> {
    if (req.method !== "POST" && req.method !== "PUT") {
      return Response.json({ error: "use POST" }, { status: 405, headers: { allow: "POST, PUT" } });
    }
    const [id, secret] = new URL(req.url).pathname.slice(watchPaths.hookPrefix.length).split("/");
    const w = id ? this.d.repos.watches.get(id) : null;
    const given = sha256(secret ?? "");
    if (w?.kind !== "webhook" || !w.secretHash || !timingSafeEqual(given, w.secretHash)) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    if (w.status !== "active")
      return Response.json({ error: `this webhook is ${w.status}` }, { status: 410 });
    const now = Date.now();
    const hits = (this.webhookHits.get(w.agentId) ?? []).filter((t) => now - t < 60 * 60_000);
    if (hits.length >= WATCH_LIMITS.webhookPerHour) {
      return Response.json({ error: "too many requests" }, { status: 429 });
    }
    hits.push(now);
    this.webhookHits.set(w.agentId, hits);
    const body = await readBody(req, WATCH_LIMITS.bodyBytes);
    const type = req.headers.get("content-type")?.split(";")[0] ?? "no content type";
    const shown = body.text.trim() ? `\n${clip(body.text, 4000)}` : " (empty body)";
    this.fire(
      w.id,
      `${w.label} received a ${req.method} (${type})${body.truncated ? ", body cut" : ""}:${shown}`,
    );
    return Response.json({ ok: true }, { status: 202 });
  }

  // ---- timers -----------------------------------------------------------------------------------

  /** Timer → fire at `fireAt`; others → expire at `expiresAt`. Overdue ones go at once. */
  private arm(w: WatchRecord): void {
    this.disarm(w.id, { keepCall: true });
    const due = w.kind === "timer" ? w.fireAt : w.expiresAt;
    if (due == null || this.stopped) return;
    // setTimeout overflows past ~24.8 days: wake up and re-arm
    const delay = Math.min(Math.max(0, due - Date.now()), 2 ** 31 - 1);
    this.timers.set(
      w.id,
      setTimeout(() => {
        this.timers.delete(w.id);
        const cur = this.d.repos.watches.get(w.id);
        if (cur?.status !== "active") return;
        if (Date.now() < due) return this.arm(cur);
        if (cur.kind === "timer") {
          this.fire(cur.id, `${cur.label} is up (set ${ago(Date.now() - cur.createdAt)} ago).`);
        } else {
          this.calls.get(cur.id)?.abort();
          this.calls.delete(cur.id);
          const what =
            cur.kind === "webhook" && cur.fireCount ? `after ${cur.fireCount} requests` : "without firing";
          this.fire(
            cur.id,
            `${cur.label} expired ${what} (registered ${ago(Date.now() - cur.createdAt)} ago).`,
            {
              status: "expired",
            },
          );
        }
      }, delay),
    );
  }

  private disarm(id: string, opts: { keepCall?: boolean } = {}): void {
    const t = this.timers.get(id);
    if (t) clearTimeout(t);
    this.timers.delete(id);
    if (opts.keepCall) return;
    this.calls.get(id)?.abort();
    this.calls.delete(id);
  }

  private forgetAgent(agentId: string): void {
    // rows are gone with the agent (ON DELETE CASCADE); drop what still runs for them
    for (const [id] of this.timers) if (!this.d.repos.watches.get(id)) this.disarm(id);
    for (const [id] of this.calls) if (!this.d.repos.watches.get(id)) this.disarm(id);
    this.inbox.delete(agentId);
    const t = this.retry.get(agentId);
    if (t) clearTimeout(t);
    this.retry.delete(agentId);
    this.webhookHits.delete(agentId);
  }

  // ---- inbox ------------------------------------------------------------------------------------

  private enqueue(f: Fired): void {
    const list = this.inbox.get(f.watch.agentId) ?? [];
    list.push(f);
    this.inbox.set(f.watch.agentId, list);
    this.flush(f.watch.agentId);
  }

  /** Deliver what's waiting for the agent, as one prompt, unless it is busy outside a call. */
  private flush(agentId: string): void {
    const items = this.inbox.get(agentId);
    if (!items?.length || this.stopped) return;
    if (!this.d.repos.agents.get(agentId)) {
      this.inbox.delete(agentId);
      return;
    }
    const prompt = compose(items);
    const depth = Math.max(...items.map((i) => i.watch.depth)) + 1;
    const callbacks = items.map((i) => i.onPrompt).filter((f) => !!f);
    const onPrompt = (h: PromptHandle) => {
      this.turnDepth.set(h.turnId, depth);
      for (const cb of callbacks) cb(h);
    };
    // A call waits for quiet itself; it takes the events now so a later firing doesn't jump ahead.
    if (this.d.speakEvent?.(agentId, prompt.text, { ...prompt, onPrompt })) {
      this.inbox.delete(agentId);
      return;
    }
    if (this.d.chat.busy(agentId)) {
      if (!this.retry.has(agentId)) {
        this.retry.set(
          agentId,
          setTimeout(() => {
            this.retry.delete(agentId);
            this.flush(agentId);
          }, RETRY_MS),
        );
      }
      return;
    }
    this.inbox.delete(agentId);
    try {
      onPrompt(this.d.chat.prompt(agentId, { source: "event", ...prompt }));
    } catch (e) {
      console.error("could not deliver a watch event", e);
    }
  }

  private publish(w: WatchRecord): void {
    this.d.bus.publish({ type: "watch.upsert", watch: toWatch(w) });
  }
}

/** One prompt for everything that fired: the texts for the DM and the agent, hidden notes for the agent. */
function compose(items: Fired[]): {
  text: string;
  note: string;
  fromAgentId: string | null;
  watch: NonNullable<PromptRequest["watch"]>;
} {
  const now = Date.now();
  const many = items.length > 1;
  const notes = items.map((f, i) => {
    const late =
      now - f.firedAt > STALE_MS ? ` It fired ${ago(now - f.firedAt)} ago; check it still matters.` : "";
    const n = many ? `(${i + 1}) ` : "";
    if (f.note) return `${n}${f.note}${late}`;
    const why = f.watch.note ? ` because: "${clip(f.watch.note, 1000)}"` : "";
    return `${n}[Background watch "${f.watch.label}" (id ${f.watch.id}) fired. You registered it ${ago(now - f.watch.createdAt)} ago${why}.${late} This is an event, not a message from the user. Continue with what you were doing for the user; tell them the outcome if it matters.]`;
  });
  const text = many ? items.map((f, i) => `(${i + 1}) ${f.text}`).join("\n\n") : items[0]!.text;
  return {
    text,
    note: notes.join("\n"),
    fromAgentId: many ? null : (items[0]!.fromAgentId ?? null),
    watch: { label: items.map((f) => f.watch.label).join(", "), watchIds: items.map((f) => f.watch.id) },
  };
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function readBody(req: Request, max: number): Promise<{ text: string; truncated: boolean }> {
  if (!req.body) return { text: "", truncated: false };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    if (size > max) {
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
  }
  const all = Buffer.concat(chunks).subarray(0, max);
  return { text: new TextDecoder().decode(all), truncated };
}

import { z } from "zod";
import { HttpError } from "../../domain/errors.ts";
import { WATCH_LIMITS } from "../../domain/watches.ts";
import { type BuiltinDeps, type BuiltinTool, iso, json, ToolError, text, tool } from "./types.ts";

const note = z
  .string()
  .min(1)
  .max(4000)
  .describe(
    "Why you care and what to do when it fires, for your future self: it comes back to you with the event, maybe in a fresh session.",
  );

const MAX_MINUTES = WATCH_LIMITS.maxMs / 60_000;

/** Service errors (limits, bad input) become errors the model sees. */
function guard<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof HttpError) throw new ToolError(e.message);
    throw e;
  }
}

/**
 * Background waits: the app waits, the agent ends its turn and gets a new one when the event
 * fires. Backed by `WatchService` (domain/watches.ts).
 */
export function watchTools(d: BuiltinDeps): BuiltinTool[] {
  const w = d.watches;
  if (!w) return [];
  const view = (x: ReturnType<typeof w.list>[number]) => ({
    id: x.id,
    kind: x.kind,
    label: x.label,
    status: x.status,
    note: x.note,
    created: iso(x.createdAt),
    ...(x.fireAt ? { fires: iso(x.fireAt) } : {}),
    ...(x.expiresAt ? { expires: iso(x.expiresAt) } : {}),
    ...(x.repeat ? { repeat: true, fired: x.fireCount } : {}),
    ...(x.status !== "active" && x.outcome ? { outcome: x.outcome } : {}),
  });
  return [
    tool({
      name: "watch_timer",
      description:
        'Get a new turn later instead of waiting now: "check back in 10 minutes", "remind the user at 9:00". When it fires you get a message with your note. Give either in_minutes or at.',
      schema: z.object({
        note,
        in_minutes: z.number().positive().max(MAX_MINUTES).optional(),
        at: z.string().optional().describe("ISO 8601 time, e.g. 2026-11-02T09:00:00+01:00."),
        label: z.string().max(80).optional().describe("Short name shown to the user."),
      }),
      run(a, ctx) {
        if ((a.in_minutes === undefined) === (a.at === undefined)) {
          throw new ToolError("give exactly one of in_minutes or at");
        }
        const fireAt = a.at !== undefined ? Date.parse(a.at) : Date.now() + a.in_minutes! * 60_000;
        if (Number.isNaN(fireAt)) throw new ToolError(`can't read the time "${a.at}"`);
        const label =
          a.label ?? (a.in_minutes !== undefined ? `Timer: ${formatMinutes(a.in_minutes)}` : undefined);
        const x = guard(() =>
          w.timer({ agentId: ctx.agentId, turnId: ctx.turnId, note: a.note, fireAt, label }),
        );
        return text(
          `Timer set (id ${x.id}), fires at ${iso(x.fireAt!)}. End your turn; you'll get a new one when it fires.`,
        );
      },
    }),
    tool({
      name: "call_in_background",
      description:
        "Run one of your other tools (a <server>__<tool> one) in the background, and get a new turn with its result when it finishes. Use it for anything that waits or takes long, instead of calling it directly and blocking: waiting for another thread's or agent's reply (e.g. a wait-for-thread tool), builds, deploys. Returns at once; end your turn or carry on with something else.",
      schema: z.object({
        tool: z.string().min(1).describe("The tool's name as you see it, e.g. t3__wait_for_thread."),
        arguments: z.record(z.string(), z.unknown()).default({}).describe("The tool's arguments."),
        note,
        timeout_minutes: z
          .number()
          .positive()
          .max(MAX_MINUTES)
          .optional()
          .describe("Give up after this long (default 24 h); you're told when it does."),
      }),
      run(a, ctx) {
        const x = guard(() =>
          w.tool({
            agentId: ctx.agentId,
            turnId: ctx.turnId,
            note: a.note,
            tool: a.tool,
            args: a.arguments,
            timeoutMs: a.timeout_minutes !== undefined ? a.timeout_minutes * 60_000 : undefined,
          }),
        );
        return text(
          `Started ${x.label} in the background (watch ${x.id}). Its result arrives as a new message when it finishes; don't wait or poll for it.`,
        );
      },
    }),
    tool({
      name: "watch_webhook",
      description:
        "Get a URL that starts a new turn for you when something requests it (POST), e.g. a CI job or a script finishing: give the URL to it. The request body comes with the event. Fires once unless repeat is true. The URL holds a secret: give it only to what should call it.",
      schema: z.object({
        note,
        expires_in_minutes: z
          .number()
          .positive()
          .max(MAX_MINUTES)
          .optional()
          .describe("Default 24 h; you're told if it expires unused."),
        repeat: z.boolean().optional().describe("Fire on every request until cancelled or expired."),
        label: z.string().max(80).optional().describe("Short name shown to the user."),
      }),
      run(a, ctx) {
        const { watch, urls } = guard(() =>
          w.webhook({
            agentId: ctx.agentId,
            turnId: ctx.turnId,
            note: a.note,
            repeat: a.repeat,
            label: a.label,
            expiresInMs: a.expires_in_minutes !== undefined ? a.expires_in_minutes * 60_000 : undefined,
          }),
        );
        if (!urls.length) throw new ToolError("the app doesn't know its own URL yet; try again in a moment");
        return json({
          id: watch.id,
          url: urls[0],
          ...(urls.length > 1 ? { local_url: urls[1] } : {}),
          method: "POST",
          expires: iso(watch.expiresAt!),
          hint:
            urls.length > 1
              ? "url works from the user's tailnet; local_url only on this machine. Neither is reachable from the public internet."
              : "Reachable from this machine only.",
        });
      },
    }),
    tool({
      name: "list_watches",
      description:
        "Your background waits (timers, background calls, webhooks, replies you wait for): active ones first, then recently ended.",
      schema: z.object({}),
      run(_, ctx) {
        return json(w.list(ctx.agentId).map(view));
      },
    }),
    tool({
      name: "cancel_watch",
      description: "Cancel one of your active watches (see list_watches). A background call is stopped.",
      schema: z.object({ id: z.string().min(1) }),
      run({ id }, ctx) {
        const x = guard(() => w.cancel(id, ctx.agentId));
        return text(`Cancelled ${x.label}.`);
      },
    }),
  ];
}

function formatMinutes(m: number): string {
  if (m < 1) return `${Math.round(m * 60)} s`;
  if (m < 120) return `${Math.round(m)} min`;
  const h = m / 60;
  return h < 48 ? `${Math.round(h * 10) / 10} h` : `${Math.round(h / 24)} days`;
}

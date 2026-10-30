import type { Watch, WatchKind } from "@vibe-center/shared";
import { Hourglass, Reply, Timer, Webhook, Wrench, X } from "lucide-react";
import { toast } from "sonner";
import { useCancelWatch, useWatches } from "@/lib/queries";
import { Button } from "./ui/button";

// Background waits: what an agent registered to be told about later (timers, background tool
// calls, webhooks, replies from other agents). The app does the waiting; when one fires, the
// agent gets a new turn whose prompt shows as an "Event" row in the DM.

export const WATCH_ICONS: Record<WatchKind, typeof Timer> = {
  timer: Timer,
  tool: Wrench,
  agent_reply: Reply,
  webhook: Webhook,
};

const STATUS_LABELS: Record<Watch["status"], string> = {
  active: "Waiting",
  fired: "Fired",
  cancelled: "Cancelled",
  expired: "Expired",
  failed: "Failed",
};

/**
 * "Waiting on …" above the composer while the agent has active watches. Clicking it opens the
 * details panel, which lists them with Cancel.
 */
export function WaitingChip({ agentId, onOpen }: { agentId: string; onOpen: () => void }) {
  const watches = useWatches(agentId);
  const active = watches.data?.filter((w) => w.status === "active") ?? [];
  if (!active.length) return null;
  const first = active[0]!;
  return (
    <button
      type="button"
      data-testid="waiting-chip"
      onClick={onOpen}
      title={active.map((w) => w.label).join("\n")}
      className="mb-2 inline-flex max-w-full items-center gap-1.5 truncate rounded-full border border-line px-2.5 py-1 text-muted-foreground text-xs transition-colors hover:border-line-strong hover:text-foreground"
    >
      <Hourglass className="size-3 shrink-0" />
      <span className="truncate">
        Waiting on {first.label}
        {active.length > 1 ? ` +${active.length - 1}` : ""}
      </span>
    </button>
  );
}

/** The details panel's list: active watches with Cancel, then the recently ended ones. */
export function WatchList({ agentId }: { agentId: string }) {
  const watches = useWatches(agentId);
  const cancel = useCancelWatch();
  const list = watches.data ?? [];
  if (!list.length) {
    return (
      <p className="text-muted-foreground text-xs">
        Nothing. Agents register these instead of blocking a turn: timers, background tool calls, webhooks,
        replies from other agents.
      </p>
    );
  }
  return (
    <ul className="space-y-1.5" data-testid="watch-list">
      {list.map((w) => {
        const Icon = WATCH_ICONS[w.kind];
        const active = w.status === "active";
        return (
          <li
            key={w.id}
            data-testid="watch"
            className="flex items-start gap-2.5 rounded-lg border border-line px-2.5 py-2 text-sm"
          >
            <Icon className={`mt-0.5 size-3.5 shrink-0 ${active ? "" : "text-muted-foreground"}`} />
            <div className="min-w-0 flex-1">
              <div className={`truncate ${active ? "" : "text-muted-foreground"}`}>{w.label}</div>
              {w.note && <div className="line-clamp-2 text-muted-foreground text-xs">{w.note}</div>}
              <div className="text-2xs text-muted-foreground">{when(w)}</div>
            </div>
            {active && (
              <Button
                variant="quiet"
                size="icon"
                className="-mr-1 size-7"
                aria-label={`Cancel ${w.label}`}
                disabled={cancel.isPending}
                onClick={() => cancel.mutate(w.id, { onError: (e) => toast.error(e.message) })}
              >
                <X className="size-3.5" />
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function when(w: Watch): string {
  const time = (ms: number) => new Date(ms).toLocaleString([], { dateStyle: "short", timeStyle: "short" });
  if (w.status !== "active") {
    const n = w.repeat && w.fireCount > 1 ? ` · ${w.fireCount}×` : "";
    return `${STATUS_LABELS[w.status]} ${time(w.updatedAt)}${n}`;
  }
  if (w.fireAt) return `Fires ${time(w.fireAt)}`;
  if (w.repeat && w.fireCount) return `Fired ${w.fireCount}× · until ${time(w.expiresAt!)}`;
  if (w.expiresAt) return `Since ${time(w.createdAt)} · gives up ${time(w.expiresAt)}`;
  return `Since ${time(w.createdAt)}`;
}

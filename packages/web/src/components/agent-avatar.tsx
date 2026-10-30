import type { AgentView, Avatar, Presence } from "@vibe-center/shared";
import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";

export const presenceLabel: Record<Presence, string> = {
  idle: "Idle",
  thinking: "Thinking",
  working: "Working",
  waiting: "Needs approval",
  in_call: "In a call",
  error: "Error",
};

/** CSS colour for a presence, as a `var()` so it follows the theme. */
export const presenceColor: Record<Presence, string> = {
  idle: "var(--presence-idle)",
  thinking: "var(--presence-thinking)",
  working: "var(--presence-working)",
  waiting: "var(--presence-waiting)",
  in_call: "var(--presence-in-call)",
  error: "var(--presence-error)",
};

export const presenceTextClass: Record<Presence, string> = {
  idle: "text-muted-foreground",
  thinking: "text-presence-thinking",
  working: "text-presence-working",
  waiting: "text-presence-waiting",
  in_call: "text-presence-in-call",
  error: "text-presence-error",
};

/** Live states glow; thinking/working pulse; idle shows no ring at all, which keeps lists quiet. */
const GLOW = new Set<Presence>(["waiting", "in_call", "error"]);
const PULSE = new Set<Presence>(["thinking", "working"]);

/**
 * One line about what the agent is doing: the presence (with its detail) in the presence colour
 * while live, else the agent's description, muted.
 */
export function statusLine(agent: AgentView): { text: string; className: string } {
  if (agent.presence === "idle") {
    return { text: agent.description || "Idle", className: "text-muted-foreground" };
  }
  const label = presenceLabel[agent.presence];
  const text = agent.presenceDetail ? `${label} · ${agent.presenceDetail}` : label;
  return { text, className: presenceTextClass[agent.presence] };
}

/**
 * Emoji on a tinted circle. With `presence`, a 2px ring sits 4px outside the avatar with a 2px
 * gap in the surface colour (`surface`, default the page background): the design's presence
 * ring. The ring is the only presence indicator; it carries the accessible label.
 */
export function AgentAvatar({
  avatar,
  presence,
  size = 32,
  surface = "var(--background)",
  className,
}: {
  avatar: Avatar;
  presence?: Presence;
  size?: number;
  /** The surface the avatar sits on, for the ring's gap. */
  surface?: string;
  className?: string;
}) {
  const live = presence !== undefined && presence !== "idle";
  const color = presence ? presenceColor[presence] : undefined;
  return (
    <span
      className={cn("relative inline-flex shrink-0 select-none", className)}
      style={{ width: size, height: size }}
    >
      {presence && (
        <span
          role="img"
          aria-label={presenceLabel[presence]}
          data-presence={presence}
          className={cn(
            "absolute rounded-full transition-[border-color,box-shadow,opacity]",
            live ? "opacity-100" : "opacity-0",
            PULSE.has(presence) && "animate-vc-pulse",
          )}
          style={{
            inset: -4,
            border: `2px solid ${color}`,
            boxShadow: GLOW.has(presence)
              ? `0 0 0 2px ${surface} inset, 0 0 14px 0 color-mix(in oklab, ${color} 45%, transparent)`
              : `0 0 0 2px ${surface} inset`,
          }}
        />
      )}
      <span
        className="relative inline-flex size-full items-center justify-center rounded-full"
        style={{
          background: `color-mix(in oklab, ${avatar.color} 24%, transparent)`,
          fontSize: Math.round(size * 0.52),
          lineHeight: 1,
        }}
      >
        <span className="translate-y-px">{avatar.emoji}</span>
      </span>
    </span>
  );
}

/** The signed-in person: a monogram on a neutral tile. */
export function UserAvatar({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center rounded-full bg-user-avatar font-semibold text-white",
        className,
      )}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42) } as CSSProperties}
    >
      Y
    </span>
  );
}

import type { Avatar, Presence } from "@vibe-center/shared";
import { cn } from "@/lib/utils";

const presenceClass: Record<Presence, string> = {
  idle: "bg-presence-idle",
  thinking: "bg-presence-thinking animate-pulse",
  working: "bg-presence-working animate-pulse",
  waiting: "bg-presence-waiting",
  in_call: "bg-presence-in-call",
  error: "bg-presence-error",
};

export const presenceLabel: Record<Presence, string> = {
  idle: "Idle",
  thinking: "Thinking",
  working: "Working",
  waiting: "Needs approval",
  in_call: "In a call",
  error: "Error",
};

export function AgentAvatar({
  avatar,
  presence,
  size = "md",
}: {
  avatar: Avatar;
  presence?: Presence;
  size?: "sm" | "md" | "lg";
}) {
  return (
    <span
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center rounded-lg",
        size === "sm" && "size-6 text-sm",
        size === "md" && "size-8 text-lg",
        size === "lg" && "size-10 text-xl",
      )}
      style={{ backgroundColor: `${avatar.color}33` }}
    >
      {avatar.emoji}
      {presence && (
        <span
          role="img"
          aria-label={presenceLabel[presence]}
          data-presence={presence}
          className={cn(
            "-right-0.5 -bottom-0.5 absolute size-2.5 rounded-full ring-2 ring-sidebar",
            presenceClass[presence],
          )}
        />
      )}
    </span>
  );
}

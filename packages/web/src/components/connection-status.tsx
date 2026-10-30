import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useConnectionState } from "@/lib/events";

/**
 * A small "Reconnecting…" pill while the live channel is down for more than a moment (a quick
 * reconnect, e.g. coming back to a phone's tab, doesn't flash it). What's on screen may be out of
 * date until it's gone; the reconnect refetches everything.
 */
export function ConnectionStatus() {
  const state = useConnectionState();
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (state === "open") return setShow(false);
    const t = setTimeout(() => setShow(true), 1000);
    return () => clearTimeout(t);
  }, [state]);
  if (!show) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-[calc(env(safe-area-inset-top)+0.5rem)] z-50 flex justify-center">
      <div
        role="status"
        data-testid="connection-status"
        className="flex items-center gap-1.5 rounded-full border bg-background/95 px-3 py-1 text-muted-foreground text-xs shadow-sm"
      >
        <Loader2 className="size-3 animate-spin" />
        Reconnecting…
      </div>
    </div>
  );
}

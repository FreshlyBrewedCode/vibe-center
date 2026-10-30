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
    <div className="pointer-events-none fixed inset-x-0 top-[calc(env(safe-area-inset-top)+0.75rem)] z-50 flex justify-center">
      <div
        role="status"
        data-testid="connection-status"
        className="elev flex animate-vc-pop items-center gap-2 rounded-full border border-line-strong bg-card px-3.5 py-1.5 text-muted-foreground text-xs"
      >
        <Loader2 className="size-3 animate-spin text-presence-waiting" />
        Reconnecting…
      </div>
    </div>
  );
}

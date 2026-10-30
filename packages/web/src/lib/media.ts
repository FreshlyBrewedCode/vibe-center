// The phone layout (agent list as its own screen, DMs pushed over it, call strip + sheet) kicks
// in below Tailwind's `sm` breakpoint. Components that must render *different* elements per
// layout (not just hide one with CSS) use this hook, so e.g. the call UI exists exactly once.
import { useSyncExternalStore } from "react";

const QUERY = "(max-width: 639px)";
const mq = typeof matchMedia === "function" ? matchMedia(QUERY) : null;

export function useIsMobile(): boolean {
  return useSyncExternalStore(
    (cb) => {
      mq?.addEventListener("change", cb);
      return () => mq?.removeEventListener("change", cb);
    },
    () => mq?.matches ?? false,
  );
}

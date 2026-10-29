// Global open/close state for the ⌘K command palette (components/command-palette.tsx), so the
// keyboard shortcut and sidebar/header buttons can all control the same singleton dialog.
import { useSyncExternalStore } from "react";

let open = false;
const listeners = new Set<() => void>();

export function setPaletteOpen(v: boolean): void {
  open = v;
  for (const l of listeners) l();
}

export function usePaletteOpen(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => open,
  );
}

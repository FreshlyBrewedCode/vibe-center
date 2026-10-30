// The desktop sidebar is an icon rail by default and expands to a list; the choice is remembered
// per device (localStorage), like the theme. ⌘\ and the panel buttons toggle it.
import { useSyncExternalStore } from "react";

export type SidebarMode = "rail" | "expanded";
const KEY = "vc-sidebar";

const listeners = new Set<() => void>();
let current: SidebarMode = localStorage.getItem(KEY) === "expanded" ? "expanded" : "rail";

export function setSidebarMode(mode: SidebarMode): void {
  current = mode;
  localStorage.setItem(KEY, mode);
  for (const l of listeners) l();
}

export function toggleSidebar(): void {
  setSidebarMode(current === "rail" ? "expanded" : "rail");
}

export function useSidebarMode(): SidebarMode {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
}

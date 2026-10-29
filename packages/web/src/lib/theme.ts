import { useSyncExternalStore } from "react";

export type Theme = "light" | "dark" | "system";
const KEY = "vc-theme"; // also read by the inline script in index.html

const listeners = new Set<() => void>();
let current: Theme = (localStorage.getItem(KEY) as Theme | null) ?? "system";
const mq = matchMedia("(prefers-color-scheme: dark)");

function apply() {
  const dark = current === "dark" || (current === "system" && mq.matches);
  document.documentElement.classList.toggle("dark", dark);
}
mq.addEventListener("change", apply);

export function setTheme(theme: Theme): void {
  current = theme;
  localStorage.setItem(KEY, theme);
  apply();
  for (const l of listeners) l();
}

export function useTheme(): Theme {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
}

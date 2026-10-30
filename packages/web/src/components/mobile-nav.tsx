import { Link, useRouterState } from "@tanstack/react-router";
import { Brain, ChevronLeft, MessageSquare, Plug, Settings } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Phone navigation (below `sm`). There is no sidebar: the agent list is the home screen with a tab
 * bar (Agents, Memories, Tools, Settings) and every other screen pushes over it with a back
 * chevron in its header.
 */

const TABS = [
  { to: "/", label: "Agents", icon: MessageSquare, match: (p: string) => p === "/" },
  { to: "/memories", label: "Memories", icon: Brain, match: (p: string) => p.startsWith("/memories") },
  { to: "/settings/mcp", label: "Tools", icon: Plug, match: (p: string) => p === "/settings/mcp" },
  {
    to: "/settings",
    label: "Settings",
    icon: Settings,
    match: (p: string) => p.startsWith("/settings") && p !== "/settings/mcp",
  },
] as const;

/** Shown on the top-level screens only; the shell decides (routes/_app.tsx). */
export function MobileTabBar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <nav
      aria-label="Sections"
      className="flex shrink-0 items-start justify-around border-line border-t bg-panel px-2 pt-2 pb-2 sm:hidden"
    >
      {TABS.map((t) => {
        const on = t.match(pathname);
        return (
          <Link
            key={t.to}
            to={t.to}
            aria-current={on ? "page" : undefined}
            className={cn(
              "flex w-16 flex-col items-center gap-1 rounded-lg py-1 text-[10.5px] transition-colors",
              on ? "font-medium text-foreground" : "text-muted-foreground",
            )}
          >
            <t.icon className="size-[22px]" strokeWidth={on ? 2.2 : 1.8} />
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}

/** Whether the tab bar belongs under this route (home, memories, settings). */
export function hasTabBar(pathname: string): boolean {
  return pathname === "/" || pathname.startsWith("/memories") || pathname.startsWith("/settings");
}

/**
 * A pushed screen's header: back chevron on the phone (desktop pages show the title only).
 * `backTo` defaults to the agent list.
 */
export function PageHeader({
  title,
  description,
  backTo = "/",
  backLabel = "Back to agents",
  actions,
  className,
}: {
  title: string;
  description?: ReactNode;
  backTo?: "/" | "/settings" | "/memories";
  backLabel?: string;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("flex shrink-0 items-start gap-2 px-3 pt-3 pb-2 sm:px-8 sm:pt-7 sm:pb-3", className)}>
      <Link
        to={backTo}
        aria-label={backLabel}
        className="-ml-1 flex size-10 shrink-0 items-center justify-center rounded-full text-foreground transition-colors hover:bg-muted sm:hidden"
      >
        <ChevronLeft className="size-6" />
      </Link>
      <div className="min-w-0 flex-1 pt-1.5 sm:pt-0">
        <h1 className="truncate font-semibold text-xl tracking-tight sm:text-2xl">{title}</h1>
        {description && <p className="mt-1 text-muted-foreground text-sm">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1 pt-1 sm:pt-0">{actions}</div>}
    </header>
  );
}

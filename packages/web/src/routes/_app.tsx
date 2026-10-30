import { createFileRoute, Outlet, useRouteContext, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { CommandPalette } from "@/components/command-palette";
import { ConnectionStatus } from "@/components/connection-status";
import { hasTabBar, MobileTabBar } from "@/components/mobile-nav";
import { Sidebar } from "@/components/sidebar";
import { GlobalCallIndicator } from "@/components/voice/call-indicator";
import { useLiveEvents } from "@/lib/events";
import { useIsMobile } from "@/lib/media";
import { useAgentNotifications } from "@/lib/notifications";
import { setPaletteOpen } from "@/lib/palette";
import { useAgents, useMe } from "@/lib/queries";
import { toggleSidebar } from "@/lib/sidebar";
import { useUnreadTitle } from "@/lib/title";
import { SignInMessage } from "./login";

/** The signed-in shell: sidebar + page, with the live event channel open. */
export const Route = createFileRoute("/_app")({ component: AppShell });

function AppShell() {
  const me = useMe();
  if (me.isPending) return null;
  if (me.isError) return <SignInMessage title="Can't reach the server" detail={me.error.message} />;
  if (!me.data) return <SignInMessage title="Not signed in" />;
  return <SignedIn deviceId={me.data.id} />;
}

/** ⌘K / Ctrl+K opens the command palette, ⌘\ / Ctrl+\ toggles the sidebar, from anywhere. */
function useShellShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(true);
      } else if (e.key === "\\") {
        e.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

function SignedIn({ deviceId }: { deviceId: string }) {
  const { queryClient } = useRouteContext({ from: "__root__" });
  useLiveEvents(queryClient, deviceId);
  useShellShortcuts();
  const agents = useAgents();
  useUnreadTitle(agents.data);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const activeAgentId = /^\/agents\/([^/]+)/.exec(pathname)?.[1] ?? null;
  useAgentNotifications(agents.data, activeAgentId);
  const mobile = useIsMobile();
  return (
    // The shell fills the viewport and never scrolls itself: each page scrolls its own content,
    // so the headers (DM header, call strip) stay put. `min-h-0` keeps `main` from growing to
    // its content's height in the phone layout's column.
    <div className="flex h-full">
      <Sidebar />
      <main className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {mobile && <GlobalCallIndicator exceptAgentId={activeAgentId ?? undefined} variant="mobile" />}
        <Outlet />
        {mobile && hasTabBar(pathname) && <MobileTabBar />}
      </main>
      <CommandPalette />
      <ConnectionStatus />
    </div>
  );
}

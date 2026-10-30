import { createFileRoute, Outlet, useRouteContext, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { CommandPalette } from "@/components/command-palette";
import { ConnectionStatus } from "@/components/connection-status";
import { MobileNav } from "@/components/mobile-nav";
import { Sidebar } from "@/components/sidebar";
import { useLiveEvents } from "@/lib/events";
import { useAgentNotifications } from "@/lib/notifications";
import { setPaletteOpen } from "@/lib/palette";
import { useAgents, useMe } from "@/lib/queries";
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

/** ⌘K / Ctrl+K opens the command palette from anywhere in the signed-in app. */
function useCommandPaletteShortcut(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

function SignedIn({ deviceId }: { deviceId: string }) {
  const { queryClient } = useRouteContext({ from: "__root__" });
  useLiveEvents(queryClient, deviceId);
  useCommandPaletteShortcut();
  const agents = useAgents();
  useUnreadTitle(agents.data);
  const activeAgentId = useRouterState({
    select: (s) => /^\/agents\/([^/]+)/.exec(s.location.pathname)?.[1] ?? null,
  });
  useAgentNotifications(agents.data, activeAgentId);
  return (
    <div className="flex h-full flex-col sm:flex-row">
      <MobileNav />
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col">
        <Outlet />
      </main>
      <CommandPalette />
      <ConnectionStatus />
    </div>
  );
}

import { createFileRoute, Outlet, useRouteContext } from "@tanstack/react-router";
import { Sidebar } from "@/components/sidebar";
import { useLiveEvents } from "@/lib/events";
import { useMe } from "@/lib/queries";
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

function SignedIn({ deviceId }: { deviceId: string }) {
  const { queryClient } = useRouteContext({ from: "__root__" });
  useLiveEvents(queryClient, deviceId);
  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col">
        <Outlet />
      </main>
    </div>
  );
}

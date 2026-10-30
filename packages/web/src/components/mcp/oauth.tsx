import type { McpServerView } from "@vibe-center/shared";
import { KeyRound, LogOut, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useIsMobile } from "@/lib/media";
import { useDisconnectMcpOAuth, useStartMcpOAuth } from "@/lib/queries";

/**
 * Starts an OAuth sign-in for a server. Desktop: a new tab (opened inside the click, so it isn't
 * blocked, then sent to the authorization page); its redirect page closes itself and this tab
 * follows the server's status over the event socket. Phone (or a blocked popup): this tab goes
 * to the authorization page and the redirect page brings it back here.
 */
export function useMcpSignIn(server: McpServerView) {
  const start = useStartMcpOAuth();
  const mobile = useIsMobile();
  const signIn = () => {
    const popup = mobile ? null : window.open("", "_blank");
    // The authorization server's page gets no handle on this tab.
    if (popup) popup.opener = null;
    start.mutate(
      { id: server.id, body: { popup: !!popup, returnTo: location.pathname + location.search } },
      {
        onSuccess: ({ authorizationUrl }) => {
          if (popup) popup.location.href = authorizationUrl;
          else location.assign(authorizationUrl);
        },
        onError: (e) => {
          popup?.close();
          toast.error(`${server.name}: ${e.message}`);
        },
      },
    );
  };
  return { signIn, pending: start.isPending };
}

/** "in 59 min", "in 3 h", "expired". */
function expiry(at: number): string {
  const ms = at - Date.now();
  if (ms <= 0) return "expired, refreshes on next use";
  const min = Math.round(ms / 60_000);
  if (min < 60) return `expires in ${min} min`;
  const h = Math.round(min / 60);
  return h < 48 ? `expires in ${h} h` : `expires in ${Math.round(h / 24)} days`;
}

/** The OAuth part of an HTTP server's row: "Needs sign-in" + Sign in, or who is signed in. */
export function McpOAuthStatus({ server: s }: { server: McpServerView }) {
  const { signIn, pending } = useMcpSignIn(s);
  const disconnect = useDisconnectMcpOAuth();
  const o = s.oauth;
  if (!o || !s.enabled) return null;
  const needsAuth = s.status.state === "needs_auth";
  if (!needsAuth && !o.connected) return null;
  return (
    <div
      data-testid="mcp-oauth"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[10px] border border-line bg-panel px-3 py-2"
    >
      <KeyRound className="size-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1 text-xs">
        {o.connected && !needsAuth ? (
          <>
            <p className="truncate">
              Signed in
              {o.account ? (
                <>
                  {" "}
                  as <span className="font-medium">{o.account}</span>
                </>
              ) : null}
              {o.issuer && <span className="text-muted-foreground"> · {new URL(o.issuer).host}</span>}
            </p>
            <p className="truncate text-muted-foreground">
              {[
                o.grantedScopes.length ? o.grantedScopes.join(" ") : null,
                o.expiresAt ? expiry(o.expiresAt) : null,
                o.refreshable ? null : "no refresh token",
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </>
        ) : (
          <p className="text-muted-foreground">
            {s.status.message ?? "This server needs you to sign in."} Every agent uses this one sign-in.
          </p>
        )}
      </div>
      {needsAuth ? (
        <Button size="sm" disabled={pending} onClick={signIn}>
          Sign in
        </Button>
      ) : (
        <>
          <Button size="sm" variant="quiet" disabled={pending} onClick={signIn}>
            <RefreshCw className="size-3.5" /> Reconnect
          </Button>
          <Button
            size="sm"
            variant="quiet"
            disabled={disconnect.isPending}
            onClick={() =>
              disconnect.mutate(s.id, {
                onSuccess: () => toast.success(`${s.name}: signed out`),
                onError: (e) => toast.error(e.message),
              })
            }
          >
            <LogOut className="size-3.5" /> Disconnect
          </Button>
        </>
      )}
    </div>
  );
}

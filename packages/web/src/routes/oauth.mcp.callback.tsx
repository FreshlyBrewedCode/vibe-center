import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import type { McpOAuthCallbackBody } from "@vibe-center/shared";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { keys, useCompleteMcpOAuth } from "@/lib/queries";

/**
 * The OAuth redirect URI (MCP_OAUTH_REDIRECT_PATH). The authorization server sends the browser
 * here from another site, so the SameSite=Strict session cookie isn't on this page load; it is
 * on the same-origin POST below, which hands the query to the server. The server checks the
 * state (single use, this device, 10 minutes) and the issuer before it uses the code.
 */
export const Route = createFileRoute("/oauth/mcp/callback")({ component: OAuthCallback });

function OAuthCallback() {
  const complete = useCompleteMcpOAuth();
  const qc = useQueryClient();
  const router = useRouter();
  const [result, setResult] = useState<{ title: string; detail?: string; failed?: boolean } | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return; // StrictMode runs effects twice; the state is single-use
    started.current = true;
    const q = new URLSearchParams(location.search);
    // The code doesn't stay in the address bar or the history.
    history.replaceState(null, "", location.pathname);
    const state = q.get("state");
    if (!state) {
      setResult({ title: "Couldn't sign in", detail: "The response has no state.", failed: true });
      return;
    }
    const body: McpOAuthCallbackBody = { state };
    for (const [param, field] of [
      ["code", "code"],
      ["iss", "iss"],
      ["error", "error"],
      ["error_description", "errorDescription"],
    ] as const) {
      const v = q.get(param);
      if (v !== null) body[field] = v;
    }
    complete.mutate(body, {
      onSuccess: (r) => {
        void qc.invalidateQueries({ queryKey: keys.mcpServers });
        if (r.popup) {
          window.close();
          // Still here: the browser didn't let the page close itself.
          setResult({ title: `Signed in to ${r.serverName}`, detail: "You can close this tab." });
        } else {
          router.history.replace(r.returnTo);
        }
      },
      onError: (e) => setResult({ title: "Couldn't sign in", detail: e.message, failed: true }),
    });
  }, [complete, qc, router]);

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div
        data-testid="oauth-callback"
        className="flex w-full max-w-sm flex-col items-center gap-5 rounded-3xl border border-line bg-card px-8 py-10 text-center"
      >
        <span className="flex size-12 items-center justify-center rounded-[14px] border border-line-strong bg-background font-semibold text-xl tracking-tight">
          V
        </span>
        <div className="space-y-1.5">
          <h1 className="font-semibold text-xl tracking-tight">{result?.title ?? "Signing in…"}</h1>
          {result?.detail && (
            <p className={result.failed ? "text-destructive text-sm" : "text-muted-foreground text-sm"}>
              {result.detail}
            </p>
          )}
        </div>
        {result && (
          <Button asChild variant="outline" size="sm">
            <Link to="/settings/mcp">MCP servers</Link>
          </Button>
        )}
      </div>
    </div>
  );
}

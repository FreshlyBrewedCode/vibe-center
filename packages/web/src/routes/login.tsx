import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { type MeResponse, paths } from "@vibe-center/shared";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { keys } from "@/lib/queries";

/**
 * Opened from the link `vibe-center start` / `vibe-center link` prints: /login#token=…
 * The token sits in the fragment so it never reaches server logs or Referer headers. It is
 * exchanged (POST, so link previews can't burn it) for the device-session cookie.
 */
export const Route = createFileRoute("/login")({ component: Login });

function Login() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return; // StrictMode runs effects twice; the token is single-use
    started.current = true;
    const token = new URLSearchParams(location.hash.slice(1)).get("token");
    history.replaceState(null, "", "/login");
    if (!token) {
      setError("This link has no sign-in token.");
      return;
    }
    api
      .post<MeResponse>(paths.authExchange, { token })
      .then((me) => {
        qc.setQueryData(keys.me, me.device);
        void navigate({ to: "/", replace: true });
      })
      .catch((e: Error) => setError(e.message));
  }, [qc, navigate]);

  return <SignInMessage title={error ? "Couldn't sign in" : "Signing in…"} detail={error} />;
}

/** The signed-out / expired-link screen: a quiet card with the one thing to do. */
export function SignInMessage({ title, detail }: { title: string; detail?: string | null }) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="flex w-full max-w-sm flex-col items-center gap-5 rounded-3xl border border-line bg-card px-8 py-10 text-center">
        <span className="flex size-12 items-center justify-center rounded-[14px] border border-line-strong bg-background font-semibold text-xl tracking-tight">
          V
        </span>
        <div className="space-y-1.5">
          <h1 className="font-semibold text-xl tracking-tight">{title}</h1>
          {detail && <p className="text-destructive text-sm">{detail}</p>}
        </div>
        <p className="text-muted-foreground text-sm leading-relaxed">
          Run <code className="rounded-[6px] bg-muted px-1.5 py-0.5 font-mono text-xs">vibe-center link</code>{" "}
          on the server and open the link it prints on this device. Links work once and expire after ten
          minutes.
        </p>
      </div>
    </div>
  );
}

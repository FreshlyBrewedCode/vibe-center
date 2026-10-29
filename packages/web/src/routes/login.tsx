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

export function SignInMessage({ title, detail }: { title: string; detail?: string | null }) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-md space-y-3 text-center">
        <div className="text-4xl">🎛️</div>
        <h1 className="font-semibold text-xl">{title}</h1>
        {detail && <p className="text-muted-foreground text-sm">{detail}</p>}
        <p className="text-muted-foreground text-sm">
          Run <code className="rounded bg-muted px-1.5 py-0.5">vibe-center link</code> on the server and open
          the link it prints on this device.
        </p>
      </div>
    </div>
  );
}

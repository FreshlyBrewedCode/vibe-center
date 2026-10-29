import { chmodSync, existsSync, unlinkSync } from "node:fs";

/**
 * The local control channel: HTTP over a unix socket in the data dir (mode 0600, dir 0700), so
 * only the user who runs the server can mint links. `vibe-center link` is its only client.
 */
export interface LinkResponse {
  /** Link to open on another device (tailnet https), or the local one if not on the tailnet. */
  url: string;
  localUrl: string;
  expiresInMinutes: number;
}

export async function startControlServer(
  socketPath: string,
  handlers: { link(): LinkResponse },
): Promise<{ stop(): void }> {
  if (existsSync(socketPath)) {
    if (await isAlive(socketPath)) throw new Error("vibe-center is already running for this data dir");
    unlinkSync(socketPath); // stale socket from a crashed server
  }
  const server = Bun.serve({
    unix: socketPath,
    fetch(req) {
      const { pathname } = new URL(req.url);
      if (req.method === "POST" && pathname === "/link") return Response.json(handlers.link());
      if (pathname === "/health") return Response.json({ ok: true, pid: process.pid });
      return new Response("not found", { status: 404 });
    },
  });
  chmodSync(socketPath, 0o600);
  return {
    stop() {
      void server.stop(true);
      if (existsSync(socketPath)) unlinkSync(socketPath);
    },
  };
}

export async function requestLink(socketPath: string): Promise<LinkResponse> {
  if (!existsSync(socketPath)) throw new Error("vibe-center is not running (no control socket found)");
  const res = await fetch("http://localhost/link", { method: "POST", unix: socketPath }).catch(() => null);
  if (!res?.ok) throw new Error("vibe-center is not responding on its control socket");
  return (await res.json()) as LinkResponse;
}

async function isAlive(socketPath: string): Promise<boolean> {
  try {
    const res = await fetch("http://localhost/health", {
      unix: socketPath,
      signal: AbortSignal.timeout(1000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

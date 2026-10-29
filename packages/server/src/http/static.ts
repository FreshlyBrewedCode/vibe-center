import { existsSync } from "node:fs";
import { join, normalize } from "node:path";

/**
 * Serves the built SPA (packages/web/dist): files as-is (hashed assets cached forever), any
 * other GET falls back to index.html so client-side routes work on reload.
 */
export function staticHandler(distDir: string): (req: Request) => Promise<Response> {
  const index = join(distDir, "index.html");
  return async (req) => {
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("not found", { status: 404 });
    if (!existsSync(index)) {
      return new Response("The web app is not built. Run `bun run build`, or start with --dev.", {
        status: 503,
      });
    }
    const path = normalize(decodeURIComponent(new URL(req.url).pathname)).replace(/^(\.\.(\/|$))+/, "");
    const file = Bun.file(join(distDir, path));
    if (path !== "/" && (await file.exists())) {
      const immutable = path.startsWith("/assets/");
      return new Response(file, {
        headers: { "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache" },
      });
    }
    return new Response(Bun.file(index), {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
    });
  };
}

export const WEB_DIST = join(import.meta.dir, "../../../web/dist");

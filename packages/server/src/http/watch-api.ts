import type { Watch, WatchesResponse } from "@vibe-center/shared";
import { Hono } from "hono";
import { HttpError } from "../domain/errors.ts";
import type { Services } from "../services.ts";
import { type AuthedEnv, handleError, requireDevice, sameOrigin } from "./middleware.ts";

/**
 * Background waits under /api: an agent's watches and cancelling one. Webhook requests
 * (`/hooks/w/…`) don't come through here; they carry their own secret (see server.ts).
 */
export function createWatchApi(s: Services): Hono<AuthedEnv> {
  const api = new Hono<AuthedEnv>();
  api.onError(handleError);
  api.use(sameOrigin, requireDevice(s));

  api.get("/agents/:id/watches", (c) => {
    const id = c.req.param("id");
    if (!s.repos.agents.get(id)) throw new HttpError(404, `agent not found: ${id}`);
    return c.json<WatchesResponse>(s.watches.list(id));
  });
  api.delete("/watches/:id", (c) => c.json<Watch>(s.watches.cancel(c.req.param("id"))));
  return api;
}

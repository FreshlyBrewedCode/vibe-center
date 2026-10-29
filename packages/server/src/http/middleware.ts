import type { ApiError, Device } from "@vibe-center/shared";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { z } from "zod";
import { SESSION_COOKIE } from "../auth/auth.ts";
import { HttpError } from "../domain/errors.ts";
import type { Services } from "../services.ts";
import { originAllowed } from "./origin.ts";

/** Hono env for routes behind `requireDevice`: `c.get("device")` is the signed-in device. */
export type AuthedEnv = { Variables: { device: Device } };

/**
 * Shared by every browser-facing router (core API, and the routers phases 2a/2b add):
 * - `sameOrigin`: CSRF guard for state-changing requests (the cookie is also SameSite=Strict)
 * - `requireDevice`: 401 unless the request carries a live device-session cookie
 * - `handleError`: HttpError / ZodError → `{ error, hint? }` JSON
 */
export const sameOrigin: MiddlewareHandler = async (c, next) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD" && !originAllowed(c.req.raw)) {
    throw new HttpError(403, "cross-origin request refused");
  }
  await next();
};

export function requireDevice(s: Services): MiddlewareHandler<AuthedEnv> {
  return async (c, next) => {
    const device = s.auth.authenticate(getCookie(c, SESSION_COOKIE));
    if (!device) throw new HttpError(401, "not signed in");
    c.set("device", device);
    await next();
  };
}

export function handleError(err: Error, c: Context): Response {
  if (err instanceof HttpError) {
    return c.json<ApiError>({ error: err.message, ...(err.hint ? { hint: err.hint } : {}) }, err.status);
  }
  if (err instanceof z.ZodError) {
    const issue = err.issues[0];
    const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    return c.json<ApiError>({ error: `${where}${issue?.message ?? "invalid request"}` }, 400);
  }
  console.error("API error", err);
  return c.json<ApiError>({ error: "internal error" }, 500);
}

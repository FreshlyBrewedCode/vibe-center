import {
  AgentBody,
  AgentPatchBody,
  type AgentResponse,
  type AgentsResponse,
  type ApiError,
  AuthExchangeBody,
  type ConversationResponse,
  type DevicesResponse,
  HarnessBody,
  type HarnessesResponse,
  HarnessPatchBody,
  type MeResponse,
  MessagesQuery,
  type MessagesResponse,
  PermissionBody,
  ReadBody,
  SearchQuery,
  type SearchResponse,
  SendMessageBody,
  type SendMessageResponse,
} from "@vibe-center/shared";
import { Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { SESSION_COOKIE, SESSION_MAX_AGE_S } from "../auth/auth.ts";
import { HttpError } from "../domain/errors.ts";
import type { Services } from "../services.ts";
import { type AuthedEnv, handleError, requireDevice, sameOrigin } from "./middleware.ts";

/**
 * The JSON API under /api. Paths and request schemas come from @vibe-center/shared (`paths`,
 * zod bodies); every route except the token exchange needs a device-session cookie.
 * Phases 2a/2b add their own routers (own files, reusing middleware.ts) and mount them in
 * server.ts rather than growing this file.
 */
export function createApi(s: Services): Hono<AuthedEnv> {
  const api = new Hono<AuthedEnv>();

  api.onError(handleError);
  api.notFound((c) => c.json<ApiError>({ error: "not found" }, 404));
  api.use(sameOrigin);

  // ---- auth (public) ---------------------------------------------------------------------------

  api.post("/auth/exchange", async (c) => {
    const body = AuthExchangeBody.parse(await c.req.json());
    const { device, secret } = s.auth.exchange(
      body.token,
      body.deviceName,
      c.req.header("user-agent") ?? null,
    );
    setCookie(c, SESSION_COOKIE, secret, {
      httpOnly: true,
      secure: true,
      sameSite: "Strict",
      path: "/",
      maxAge: SESSION_MAX_AGE_S,
    });
    return c.json<MeResponse>({ device });
  });

  // ---- everything else needs a device session ---------------------------------------------------

  api.use(requireDevice(s));

  api.get("/auth/me", (c) => c.json<MeResponse>({ device: c.get("device") }));
  api.post("/auth/logout", (c) => {
    s.auth.revoke(c.get("device").id);
    deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
    return c.body(null, 204);
  });

  // ---- agents ----------------------------------------------------------------------------------

  api.get("/agents", (c) => c.json<AgentsResponse>(s.agents.list()));
  api.post("/agents", async (c) => {
    const agent = s.agents.create(AgentBody.parse(await c.req.json()));
    return c.json<AgentResponse>(agent, 201);
  });
  api.get("/agents/:id", (c) => c.json<AgentResponse>(s.agents.get(c.req.param("id"))));
  api.patch("/agents/:id", async (c) => {
    const agent = s.agents.update(c.req.param("id"), AgentPatchBody.parse(await c.req.json()));
    return c.json<AgentResponse>(agent);
  });
  api.delete("/agents/:id", async (c) => {
    await s.agents.delete(c.req.param("id"));
    return c.body(null, 204);
  });

  // ---- conversations ---------------------------------------------------------------------------

  api.get("/conversations/:id", (c) => {
    const conversation = s.repos.conversations.get(c.req.param("id"));
    if (!conversation) throw new HttpError(404, "conversation not found");
    return c.json<ConversationResponse>({
      conversation,
      sessions: s.repos.conversations.sessions(conversation.id),
    });
  });
  api.get("/conversations/:id/messages", (c) => {
    const q = MessagesQuery.parse(c.req.query());
    return c.json<MessagesResponse>(s.repos.messages.list(c.req.param("id"), q));
  });
  api.post("/conversations/:id/messages", async (c) => {
    const { text } = SendMessageBody.parse(await c.req.json());
    const handle = s.chat.send(c.req.param("id"), text);
    return c.json<SendMessageResponse>({ message: handle.message!, turnId: handle.turnId }, 201);
  });
  api.post("/conversations/:id/cancel", async (c) => {
    await s.chat.cancel(c.req.param("id"));
    return c.body(null, 204);
  });
  api.post("/conversations/:id/sessions", async (c) => {
    return c.json(await s.chat.newSession(c.req.param("id")), 201);
  });
  api.post("/conversations/:id/read", async (c) => {
    const { seq } = ReadBody.parse(await c.req.json());
    s.chat.markRead(c.req.param("id"), seq);
    return c.body(null, 204);
  });
  api.post("/messages/:id/permission", async (c) => {
    const { optionId } = PermissionBody.parse(await c.req.json());
    s.chat.respondPermission(c.req.param("id"), optionId);
    return c.body(null, 204);
  });
  api.get("/search", (c) => {
    const q = SearchQuery.parse(c.req.query());
    return c.json<SearchResponse>(s.repos.messages.search(q.q, q));
  });

  // ---- harnesses -------------------------------------------------------------------------------

  api.get("/harnesses", (c) => c.json<HarnessesResponse>(s.harnesses.list()));
  api.post("/harnesses", async (c) => c.json(s.harnesses.create(HarnessBody.parse(await c.req.json())), 201));
  api.patch("/harnesses/:id", async (c) => {
    const harness = s.harnesses.update(c.req.param("id"), HarnessPatchBody.parse(await c.req.json()));
    s.chat.reconfigureHarness(harness.id);
    return c.json(harness);
  });
  api.delete("/harnesses/:id", (c) => {
    s.harnesses.delete(c.req.param("id"));
    return c.body(null, 204);
  });
  api.post("/harnesses/:id/probe", async (c) => {
    const deep = c.req.query("deep") === "1";
    return c.json(await s.harnesses.probe(c.req.param("id"), { deep }));
  });

  // ---- devices ---------------------------------------------------------------------------------

  api.get("/devices", (c) => c.json<DevicesResponse>(s.auth.listDevices(c.get("device").id)));
  api.delete("/devices/:id", (c) => {
    s.auth.revoke(c.req.param("id"));
    return c.body(null, 204);
  });

  return api;
}

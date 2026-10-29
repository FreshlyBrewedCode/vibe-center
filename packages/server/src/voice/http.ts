import {
  CallEventBody,
  type CallsResponse,
  GPU_SPEECH_ACTIONS,
  type GpuSpeechAction,
  IceBody,
  PreviewBody,
  StartCallBody,
  type StartCallResponse,
  type VoiceSettings,
  VoiceSettingsPatchBody,
  type VoiceStatus,
  type VoicesResponse,
} from "@vibe-center/shared";
import { Hono } from "hono";
import { HttpError } from "../domain/errors.ts";
import { type AuthedEnv, handleError, requireDevice, sameOrigin } from "../http/middleware.ts";
import type { Services } from "../services.ts";

/** /api/voice: settings, health, voices, and call signalling (proxied to the worker). */
export function createVoiceApi(s: Services): Hono<AuthedEnv> {
  const api = new Hono<AuthedEnv>();
  const v = s.voice;
  api.onError(handleError);
  api.use(sameOrigin);
  api.use(requireDevice(s));

  api.get("/settings", (c) => c.json<VoiceSettings>(v.settings()));
  api.patch("/settings", async (c) =>
    c.json<VoiceSettings>(await v.updateSettings(VoiceSettingsPatchBody.parse(await c.req.json()))),
  );
  api.get("/status", async (c) => {
    if (c.req.query("refresh") === "1") await v.checkHealth();
    return c.json<VoiceStatus>(v.status());
  });
  api.post("/worker/restart", async (c) => c.json<VoiceStatus>(await v.restartWorker()));
  api.post("/gpu-speech/:action", (c) => {
    const action = c.req.param("action") as GpuSpeechAction;
    if (!GPU_SPEECH_ACTIONS.includes(action)) throw new HttpError(404, "unknown action");
    return c.json<VoiceStatus>(v.gpuSpeech(action), 202);
  });

  api.get("/voices", async (c) => c.json<VoicesResponse>(await v.voices()));
  api.post("/preview", async (c) => {
    const body = PreviewBody.parse(await c.req.json());
    return v.preview(body.voice, body.text);
  });

  api.get("/calls", (c) => c.json<CallsResponse>(v.listCalls()));
  api.post("/calls", async (c) => {
    const body = StartCallBody.parse(await c.req.json());
    return c.json<StartCallResponse>(await v.startCall(c.get("device").id, body), 201);
  });
  api.patch("/calls/:id/ice", async (c) => {
    await v.ice(c.req.param("id"), IceBody.parse(await c.req.json()));
    return c.body(null, 204);
  });
  api.delete("/calls/:id", async (c) => {
    await v.hangUp(c.req.param("id"));
    return c.body(null, 204);
  });
  api.post("/calls/:id/event", async (c) => {
    v.injectEvent(c.req.param("id"), CallEventBody.parse(await c.req.json()).text);
    return c.body(null, 204);
  });
  return api;
}

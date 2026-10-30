#!/usr/bin/env bun
// A stand-in for the Python voice worker (services/voice) in bun tests: the same HTTP API and
// bridge protocol, no audio. The app spawns it like the real one (VC_WORKER_PORT, VC_WORKER_TOKEN).
// Tests drive the "caller" through /test/* (no auth):
//
//   POST /test/say {text, kind?, context?}  send a prompt over the bridge  → {id}
//   POST /test/cancel {id}                  barge-in, turn still running
//   POST /test/interrupted {id}             barge-in, turn already finished
//   POST /test/state {state}                report listening/thinking/speaking
//   GET  /test/frames                       every frame the app sent on the bridge
//   POST /test/crash                        exit(1), for restart tests
//   GET  /test/requests                     the app's requests to the worker API
//
// FAKE_WORKER_SLOW_START_MS delays readiness (/health says "loading" until then).

const port = Number(process.env.VC_WORKER_PORT ?? 0);
const token = process.env.VC_WORKER_TOKEN ?? "";
const readyAt = Date.now() + Number(process.env.FAKE_WORKER_SLOW_START_MS ?? 0);

let bridge: WebSocket | null = null;
let callId: string | null = null;
const frames: Record<string, unknown>[] = [];
const requests: { method: string; path: string; body: unknown }[] = [];

const json = (data: unknown, status = 200) => Response.json(data, { status });

async function connectBridge(url: string, bridgeToken: string): Promise<void> {
  const ws = new WebSocket(url, { headers: { authorization: `Bearer ${bridgeToken}` } } as never);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("no hello from the app")), 3000);
    ws.onmessage = (m) => {
      const f = JSON.parse(String(m.data)) as Record<string, unknown>;
      frames.push(f);
      if (f.type === "hello") {
        clearTimeout(t);
        resolve();
      }
      if (f.type === "end") ws.close();
    };
    ws.onerror = () => reject(new Error("bridge connection failed"));
    ws.onclose = () => {
      clearTimeout(t);
      if (bridge === ws) bridge = null;
      reject(new Error("bridge closed"));
    };
  });
  bridge = ws;
}

Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(req) {
    const { pathname } = new URL(req.url);
    const body = req.method === "GET" || req.method === "DELETE" ? null : await req.json().catch(() => null);

    if (pathname.startsWith("/test/")) {
      const b = (body ?? {}) as Record<string, string>;
      switch (pathname) {
        case "/test/say": {
          if (!bridge) return json({ error: "no bridge" }, 409);
          const id = crypto.randomUUID().slice(0, 8);
          bridge.send(
            JSON.stringify({ type: "prompt", id, text: b.text, kind: b.kind ?? "user", context: b.context }),
          );
          return json({ id });
        }
        case "/test/cancel":
          bridge?.send(JSON.stringify({ type: "cancel", id: b.id }));
          return json({ ok: true });
        case "/test/interrupted":
          bridge?.send(JSON.stringify({ type: "interrupted", id: b.id }));
          return json({ ok: true });
        case "/test/state":
          bridge?.send(JSON.stringify({ type: "state", state: b.state }));
          return json({ ok: true });
        case "/test/latency":
          bridge?.send(
            JSON.stringify({
              type: "latency",
              turn: 1,
              kind: "user",
              ms: { first_audio_out: 1234 },
              bargeIn: null,
              tools: 0,
            }),
          );
          return json({ ok: true });
        case "/test/frames":
          return json(frames);
        case "/test/requests":
          return json(requests);
        case "/test/crash":
          setTimeout(() => process.exit(1), 10);
          return json({ ok: true });
      }
    }

    if (req.headers.get("authorization") !== `Bearer ${token}`)
      return json({ detail: "bad worker token" }, 401);
    requests.push({ method: req.method, path: pathname, body });
    if (pathname === "/health") {
      const ready = Date.now() >= readyAt;
      return json({
        status: ready ? "ok" : "loading",
        error: null,
        version: "fake",
        call: callId ? { id: callId } : null,
      });
    }
    if (pathname === "/calls" && req.method === "POST") {
      const b = body as { call_id: string; bridge_url: string; bridge_token: string; sdp: string };
      if (b.sdp.includes("refuse")) return json({ detail: "bad offer: refused" }, 400);
      try {
        await connectBridge(b.bridge_url, b.bridge_token);
      } catch (e) {
        return json({ detail: (e as Error).message }, 502);
      }
      callId = b.call_id;
      bridge?.send(JSON.stringify({ type: "state", state: "listening" }));
      return json({
        sdp: "v=0 fake-answer",
        type: "answer",
        pc_id: "pc-1",
        speech: { stt: "cpu", tts: "cpu" },
      });
    }
    if (pathname.endsWith("/ice") && req.method === "PATCH") return json({ status: "ok" });
    if (pathname.startsWith("/calls/") && req.method === "DELETE") {
      bridge?.close();
      callId = null;
      return new Response(null, { status: 204 });
    }
    if (pathname === "/voices")
      return json({ voices: ["af_heart", "bm_george"], default: "af_heart", source: "cpu" });
    if (pathname === "/tts")
      return new Response(new Uint8Array(44), { headers: { "content-type": "audio/wav" } });
    return json({ detail: "not found" }, 404);
  },
});
console.log(`fake voice worker on ${port}`);

"""HTTP server: client page, SmallWebRTC signalling, proactive-event injection, live event stream.

    uv run python -m voice_loop.server        (see README for env vars and tailscale serve)

Routes:
    GET  /               client page (client/index.html)
    POST /api/offer      WebRTC offer -> answer (non-trickle; PATCH accepts trickled candidates)
    POST /event          {"text": "..."} -> queued "[event] ..." prompt, spoken when user and bot are idle
    GET  /events         server-sent events: transcripts, replies, per-turn latency records
    GET  /status         backend, active call, talker pool state
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from fastapi import BackgroundTasks, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, Response, StreamingResponse
from loguru import logger

from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
from pipecat.transports.smallwebrtc.request_handler import (
    SmallWebRTCPatchRequest,
    SmallWebRTCRequest,
    SmallWebRTCRequestHandler,
)

from .acp_talker import AcpTalker
from .call import Call
from .config import CONFIG, ROOT
from .cues import Cues
from .speech import preload, resolve_backend

CLIENT_DIR = ROOT / "client"


class TalkerPool:
    """Keeps one ACP session spawned and warmed up, so a call starts without the ~1.5 s spawn
    and the cache-cold first turn. Each call takes it and a fresh one is prepared."""

    def __init__(self):
        self._next: asyncio.Task[AcpTalker] | None = None

    async def _make(self) -> AcpTalker:
        sid = uuid.uuid4().hex[:8]
        t = AcpTalker(
            model=CONFIG.talker_model,
            workdir=ROOT / "scratch" / f"session-{sid}",
            tool_log=CONFIG.log_dir / "tool-calls.jsonl",
        )
        await t.start()
        if CONFIG.warmup:
            ms = await t.warmup()
            logger.info(f"talker warm-up turn took {ms:.0f} ms")
        return t

    def prewarm(self):
        if self._next is None:
            self._next = asyncio.create_task(self._make())

    async def take(self) -> AcpTalker:
        self.prewarm()
        task, self._next = self._next, None
        talker = await task
        self.prewarm()
        return talker

    @property
    def state(self) -> str:
        if self._next is None:
            return "none"
        return "ready" if self._next.done() else "warming"

    async def close(self):
        if self._next:
            if self._next.done() and not self._next.exception():
                await self._next.result().close()
            else:
                self._next.cancel()


class Hub:
    """Fan-out of call events to /events subscribers (the client page, the e2e test)."""

    def __init__(self):
        self.subs: set[asyncio.Queue] = set()

    def publish(self, ev: dict):
        ev = {"t": time.time() * 1000, **ev}
        for q in list(self.subs):
            q.put_nowait(ev)


STATE: dict = {"backend": None, "cues": None, "call": None}
pool = TalkerPool()
hub = Hub()
webrtc = SmallWebRTCRequestHandler()


@asynccontextmanager
async def lifespan(app: FastAPI):
    CONFIG.log_dir.mkdir(parents=True, exist_ok=True)
    STATE["backend"] = backend = await asyncio.to_thread(resolve_backend, CONFIG)
    await asyncio.to_thread(preload, backend, CONFIG)
    STATE["cues"] = await asyncio.to_thread(Cues(backend, CONFIG).load)
    pool.prewarm()
    logger.info(f"voice-loop ready: backend={backend}, open http://{CONFIG.host}:{CONFIG.port}/")
    yield
    if STATE["call"] and STATE["call"].task:
        await STATE["call"].task.cancel()
    await webrtc.close()
    await pool.close()


app = FastAPI(lifespan=lifespan)


@app.get("/")
async def index():
    return FileResponse(CLIENT_DIR / "index.html")


@app.get("/favicon.ico")
async def favicon():
    return Response(status_code=204)


@app.get("/status")
async def status():
    call = STATE["call"]
    return {
        "backend": STATE["backend"],
        "talker_pool": pool.state,
        "call": call.id if call else None,
        "idle": call.processor.idle if call and call.processor else None,
    }


async def _run_call(connection: SmallWebRTCConnection):
    if STATE["call"] is not None:
        logger.warning("a call is already active; ending it for the new one")
        await STATE["call"].task.cancel()
    talker = await pool.take()
    call = Call(
        connection=connection, talker=talker, backend=STATE["backend"], cues=STATE["cues"], cfg=CONFIG, publish=hub.publish
    )
    STATE["call"] = call
    try:
        await call.run()
    except Exception as e:
        logger.exception(f"call failed: {e}")
    finally:
        if STATE["call"] is call:
            STATE["call"] = None


@app.post("/api/offer")
async def offer(request: SmallWebRTCRequest, background_tasks: BackgroundTasks):
    async def on_connection(connection: SmallWebRTCConnection):
        background_tasks.add_task(_run_call, connection)

    return await webrtc.handle_web_request(request=request, webrtc_connection_callback=on_connection)


@app.patch("/api/offer")
async def ice_candidate(request: SmallWebRTCPatchRequest):
    await webrtc.handle_patch_request(request)
    return {"status": "success"}


@app.post("/event")
async def inject_event(request: Request):
    body = await request.json()
    text = (body.get("text") or "").strip()
    call = STATE["call"]
    if not text:
        raise HTTPException(400, "missing text")
    if call is None or call.processor is None:
        raise HTTPException(409, "no active call")
    call.processor.inject_event(text)
    return {"status": "queued", "idle_now": call.processor.idle}


@app.get("/events")
async def events():
    q: asyncio.Queue = asyncio.Queue()
    hub.subs.add(q)

    async def stream():
        try:
            yield "retry: 1000\n\n"
            while True:
                try:
                    ev = await asyncio.wait_for(q.get(), 15)
                    yield f"data: {json.dumps(ev)}\n\n"
                except TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            hub.subs.discard(q)

    return StreamingResponse(stream(), media_type="text/event-stream")


def main():
    uvicorn.run(app, host=CONFIG.host, port=CONFIG.port, log_level="warning")


if __name__ == "__main__":
    main()

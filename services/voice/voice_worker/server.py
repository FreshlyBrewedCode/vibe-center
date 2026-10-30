"""The worker's HTTP API, used only by the Vibe Center app (Bearer VC_WORKER_TOKEN on every route).

    GET    /health               {"status": "ok"|"loading", "call": {...}|null, ...}
    POST   /calls                start a call: CallConfig + the browser's WebRTC offer -> answer
    PATCH  /calls/{id}/ice       trickled ICE candidates from the browser
    DELETE /calls/{id}           hang up
    GET    /voices?tts_url=      TTS voices (the GPU server's list, else the CPU Kokoro's)
    POST   /tts                  {"text", "voice", "tts_url"} -> audio/wav (voice preview)
    GET    /recordings           debug turn recordings (newest first), if a call kept any
    GET    /recordings/{id}.wav  one of them
    DELETE /recordings           delete them all

The browser never talks to this server: the app proxies signalling (cookie-authenticated, same
origin), and only the WebRTC media flows directly between the browser and this host.

    uv run python -m voice_worker        (env: see config.py)
"""

from __future__ import annotations

import asyncio
import contextlib
import hmac
import sys
from contextlib import asynccontextmanager
from typing import Any

import uvicorn
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, Response
from loguru import logger
from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
from pipecat.transports.smallwebrtc.request_handler import (
    IceCandidate,
    SmallWebRTCPatchRequest,
    SmallWebRTCRequest,
    SmallWebRTCRequestHandler,
)
from pydantic import BaseModel

from .bridge import Bridge, BridgeError
from .call import RECORDINGS, Call
from .config import CONFIG, CallConfig
from .speech import healthy, local_voices, pcm_to_wav_bytes, preload, synth_pcm

VERSION = "0.2.0"
STATE: dict[str, Any] = {"ready": False, "call": None, "call_task": None, "error": None}
webrtc = SmallWebRTCRequestHandler()


async def _load():
    try:
        await asyncio.to_thread(preload)
        CONFIG.log_dir.mkdir(parents=True, exist_ok=True)
        STATE["ready"] = True
        logger.info(f"voice worker ready on http://{CONFIG.host}:{CONFIG.port}")
    except Exception as e:
        STATE["error"] = repr(e)
        logger.exception(f"model preload failed: {e}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    loader = asyncio.create_task(_load())
    yield
    loader.cancel()
    call: Call | None = STATE["call"]
    if call:
        call.end("worker stopping")
        if STATE["call_task"]:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(STATE["call_task"], 5)
    await webrtc.close()


app = FastAPI(lifespan=lifespan)


def require_token(request: Request) -> None:
    sent = request.headers.get("authorization", "").removeprefix("Bearer ").strip()
    if not hmac.compare_digest(sent.encode(), CONFIG.token.encode()):
        raise HTTPException(401, "bad worker token")


def _require_ready() -> None:
    if not STATE["ready"]:
        raise HTTPException(503, "the voice worker is still loading its models")


@app.get("/health", dependencies=[Depends(require_token)])
async def health():
    call: Call | None = STATE["call"]
    return {
        "status": "ok" if STATE["ready"] else "error" if STATE["error"] else "loading",
        "error": STATE["error"],
        "version": VERSION,
        "call": {"id": call.id, "stt": call.stt_url or "cpu", "tts": call.tts_url or "cpu"} if call else None,
    }


class CallRequest(BaseModel):
    call_id: str
    bridge_url: str
    bridge_token: str
    agent_name: str = "agent"
    voice: str | None = None
    stt_url: str = ""
    tts_url: str = ""
    filler: bool = True
    vocabulary: list[str] = []
    record_turns: int = 0
    sdp: str
    type: str = "offer"


async def _end_current():
    call: Call | None = STATE["call"]
    if call is None:
        return
    logger.warning(f"ending call {call.id} for a new one")
    call.end("replaced by a new call")
    task = STATE["call_task"]
    if task:
        with contextlib.suppress(Exception):
            await asyncio.wait_for(asyncio.shield(task), 5)


@app.post("/calls", dependencies=[Depends(require_token)])
async def start_call(req: CallRequest):
    _require_ready()
    await _end_current()
    cfg = CallConfig(
        call_id=req.call_id,
        bridge_url=req.bridge_url,
        bridge_token=req.bridge_token,
        agent_name=req.agent_name,
        voice=req.voice or CONFIG.default_voice,
        stt_url=req.stt_url,
        tts_url=req.tts_url,
        filler=req.filler,
        vocabulary=[t.strip()[:100] for t in req.vocabulary if t.strip()][:200],
        record_turns=max(0, min(req.record_turns, 500)),
    )
    # per call: use a GPU server only if it answers right now (one that appears later is used
    # by the next call; one that disappears mid-call falls back per request)
    stt_ok, tts_ok = await asyncio.gather(
        asyncio.to_thread(healthy, cfg.stt_url), asyncio.to_thread(healthy, cfg.tts_url)
    )
    try:
        bridge = await Bridge.connect(cfg.bridge_url, cfg.bridge_token)
    except BridgeError as e:
        raise HTTPException(502, str(e)) from e
    call = Call(cfg, bridge, stt_url=cfg.stt_url if stt_ok else None, tts_url=cfg.tts_url if tts_ok else None)
    STATE["call"] = call

    async def run(connection: SmallWebRTCConnection):
        try:
            await call.run(connection)
        except Exception as e:
            logger.exception(f"call {call.id} failed: {e}")
        finally:
            if STATE["call"] is call:
                STATE["call"], STATE["call_task"] = None, None

    async def on_connection(connection: SmallWebRTCConnection):
        STATE["call_task"] = asyncio.create_task(run(connection))

    try:
        answer = await webrtc.handle_web_request(
            request=SmallWebRTCRequest(sdp=req.sdp, type=req.type), webrtc_connection_callback=on_connection
        )
    except Exception as e:
        STATE["call"] = None
        await bridge.close()
        raise HTTPException(400, f"bad offer: {e}") from e
    if not answer:
        raise HTTPException(500, "no answer")
    return {**answer, "speech": {"stt": call.stt_url or "cpu", "tts": call.tts_url or "cpu"}}


class IceBody(BaseModel):
    pc_id: str
    candidates: list[dict]


@app.patch("/calls/{call_id}/ice", dependencies=[Depends(require_token)])
async def ice(call_id: str, body: IceBody):
    call: Call | None = STATE["call"]
    if call is None or call.id != call_id:
        raise HTTPException(404, "no such call")
    candidates = [
        IceCandidate(
            candidate=c["candidate"].removeprefix("candidate:"),
            sdp_mid=c.get("sdp_mid") or "0",
            sdp_mline_index=c.get("sdp_mline_index") or 0,
        )
        for c in body.candidates
        if c.get("candidate")
    ]
    await webrtc.handle_patch_request(SmallWebRTCPatchRequest(pc_id=body.pc_id, candidates=candidates))
    return {"status": "ok"}


@app.delete("/calls/{call_id}", dependencies=[Depends(require_token)])
async def hang_up(call_id: str):
    call: Call | None = STATE["call"]
    if call is not None and call.id == call_id:
        call.end("hung up")
    return Response(status_code=204)


@app.get("/voices", dependencies=[Depends(require_token)])
async def voices(tts_url: str = ""):
    if tts_url:
        import httpx

        try:
            async with httpx.AsyncClient(timeout=2) as c:
                r = await c.get(f"{tts_url.rstrip('/')}/v1/audio/voices")
                r.raise_for_status()
                data = r.json()
                return {
                    "voices": data["voices"],
                    "default": data.get("default", CONFIG.default_voice),
                    "source": "server",
                }
        except Exception as e:
            logger.info(f"TTS server voice list unavailable ({e!r}); using the CPU voices")
    _require_ready()
    return {"voices": await asyncio.to_thread(local_voices), "default": CONFIG.default_voice, "source": "cpu"}


class TtsBody(BaseModel):
    text: str
    voice: str | None = None
    tts_url: str = ""


@app.post("/tts", dependencies=[Depends(require_token)])
async def tts(body: TtsBody):
    _require_ready()
    text = body.text.strip()[:500]
    if not text:
        raise HTTPException(400, "empty text")
    voice = body.voice or CONFIG.default_voice
    url = body.tts_url if body.tts_url and await asyncio.to_thread(healthy, body.tts_url) else None
    try:
        pcm = await asyncio.to_thread(synth_pcm, text, url, voice)
    except Exception as e:
        raise HTTPException(502, f"synthesis failed: {e}") from e
    return Response(pcm_to_wav_bytes(pcm), media_type="audio/wav", headers={"X-Speech": url or "cpu"})


@app.get("/recordings", dependencies=[Depends(require_token)])
async def recordings():
    return {"recordings": await asyncio.to_thread(RECORDINGS.list)}


@app.get("/recordings/{rid}.wav", dependencies=[Depends(require_token)])
async def recording(rid: str):
    path = RECORDINGS.wav(rid)
    if path is None:
        raise HTTPException(404, "no such recording")
    return FileResponse(path, media_type="audio/wav")


@app.delete("/recordings", dependencies=[Depends(require_token)])
async def clear_recordings():
    return {"deleted": await asyncio.to_thread(RECORDINGS.clear)}


def main():
    if not CONFIG.token:
        print("VC_WORKER_TOKEN is not set; the app passes it when it starts the worker", file=sys.stderr)
        sys.exit(2)
    uvicorn.run(app, host=CONFIG.host, port=CONFIG.port, log_level="warning")


if __name__ == "__main__":
    main()

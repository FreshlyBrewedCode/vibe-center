"""STT server: an OpenAI-compatible POST /v1/audio/transcriptions served by the active model of
a small catalog (catalog.py), plus an API to download, delete and switch models (models.py):

    GET    /v1/stt/models                 catalog with status, progress, disk size
    POST   /v1/stt/models/{id}/download   start a download (202)
    DELETE /v1/stt/models/{id}/download   cancel it
    POST   /v1/stt/models/{id}/activate   load it and serve it once warmed up (202), hot swap
    DELETE /v1/stt/models/{id}            delete its files (not the active one)

Only the default model is downloaded up front (prepare.py); the rest when someone asks.
"""
import io, logging, os, time
from contextlib import asynccontextmanager
from pathlib import Path

import numpy as np, soundfile as sf, soxr
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse, PlainTextResponse
import common  # noqa: F401  (logging setup)
from models import ModelManager, NotReady

log = logging.getLogger("stt")
SR = 16000
MODELS_DIR = Path(os.environ.get("GPU_SPEECH_MODELS", "~/.cache/gpu-speech/models")).expanduser()


def create_app(manager: ModelManager, *, start: bool = True) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app):
        if start:
            manager.start(wait=True)
        yield
        manager.stop()

    app = FastAPI(title="gpu-speech STT", lifespan=lifespan)

    @app.get("/health")
    def health():
        if not manager.active:
            why = f"loading {manager.loading}" if manager.loading else "no model loaded"
            return JSONResponse({"status": "loading" if manager.loading else "no_model", "detail": why},
                                status_code=503)
        return {"status": "ok", "model": manager.active}

    @app.get("/v1/models")
    def openai_models():
        return {"object": "list", "data": [{"id": m["id"], "object": "model", "owned_by": "vibe-center"}
                                           for m in manager.list()["models"] if m["status"] == "active"]}

    @app.get("/v1/stt/models")
    def stt_models():
        return manager.list()

    def call(fn, mid):
        try:
            return fn(mid)
        except KeyError:
            raise HTTPException(404, f"no model {mid!r} in the catalog")
        except ValueError as e:
            raise HTTPException(409, str(e))

    @app.post("/v1/stt/models/{mid}/download", status_code=202)
    def download(mid: str):
        return call(manager.download, mid)

    @app.delete("/v1/stt/models/{mid}/download")
    def cancel(mid: str):
        return call(manager.cancel, mid)

    @app.post("/v1/stt/models/{mid}/activate", status_code=202)
    def activate(mid: str):
        return call(manager.activate, mid)

    @app.delete("/v1/stt/models/{mid}")
    def delete(mid: str):
        return call(manager.delete, mid)

    @app.post("/v1/audio/transcriptions")
    def transcriptions(file: UploadFile = File(...), model: str = Form(None), language: str = Form(None),
                       prompt: str = Form(None), response_format: str = Form("json"),
                       temperature: float = Form(None)):
        # `model` and `temperature` are accepted for OpenAI compatibility and ignored: the active
        # model serves. `prompt` is the custom vocabulary, used by models that support it.
        t0 = time.perf_counter()
        audio = decode(file.file.read())
        dur = len(audio) / SR
        text, served = "", manager.active
        if dur >= 0.1:
            try:
                r = manager.transcribe(audio, prompt or None, (language or "").split("-")[0].lower() or None)
            except NotReady as e:
                raise HTTPException(503, str(e))
            except RuntimeError as e:
                raise HTTPException(500, str(e))
            text, served = r["text"], r["model"]
        ms = (time.perf_counter() - t0) * 1000
        log.info("%s: %.2fs audio -> %.0f ms: %r", served, dur, ms, text)
        headers = {"X-Processing-Ms": f"{ms:.1f}", "X-Model": served or ""}
        if response_format == "text":
            return PlainTextResponse(text, headers=headers)
        body = {"text": text}
        if response_format == "verbose_json":
            body.update(language=language or "", duration=round(dur, 3), model=served)
        return JSONResponse(body, headers=headers)

    return app


def decode(data: bytes) -> np.ndarray:
    try:
        audio, sr = sf.read(io.BytesIO(data), dtype="float32", always_2d=True)
    except Exception as e:
        raise HTTPException(400, f"cannot decode audio (send WAV/FLAC/OGG): {e}")
    audio = audio.mean(axis=1)
    return soxr.resample(audio, sr, SR) if sr != SR else audio


if __name__ == "__main__":
    import uvicorn
    app = create_app(ModelManager(MODELS_DIR))
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("STT_PORT", 8401)), log_level="warning")

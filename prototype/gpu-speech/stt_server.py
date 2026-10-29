"""STT server: NVIDIA Parakeet-TDT 0.6B v2 (fp16 ONNX, onnxruntime CUDA) behind an
OpenAI-compatible POST /v1/audio/transcriptions. English only."""
import io, logging, os, threading, time
from contextlib import asynccontextmanager

import numpy as np, onnx_asr, onnxruntime as ort, soundfile as sf, soxr
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse, PlainTextResponse
from common import PARAKEET_DIR

log = logging.getLogger("stt")
MODEL_ID = "parakeet-tdt-0.6b-v2"
SR = 16000
# onnxruntime's CUDA kernels keep their setup for the last input shape only: each new
# length costs ~170 ms extra, a repeated one ~20-50 ms. So every utterance is padded
# with silence to a multiple of PAD seconds (one shape for all normal utterances).
PAD = int(float(os.environ.get("STT_PAD_SECONDS", 16)) * SR)
state = {"ready": False}
gpu = threading.Lock()  # one inference at a time on the GPU


def load():
    so = ort.SessionOptions(); so.log_severity_level = 3
    # grow the memory arena only as needed; heuristic cuDNN conv algorithms (no
    # per-input-length exhaustive search, no huge workspaces)
    cuda = ("CUDAExecutionProvider", {"arena_extend_strategy": "kSameAsRequested",
            "cudnn_conv_algo_search": "HEURISTIC", "cudnn_conv_use_max_workspace": "0"})
    quant = os.environ.get("STT_PRECISION", "fp16")  # fp16 | fp32
    t = time.perf_counter()
    model = onnx_asr.load_model("nemo-parakeet-tdt-0.6b-v2", PARAKEET_DIR, providers=[cuda],
                                sess_options=so, quantization=None if quant == "fp32" else quant)
    # warm up on the padded shape so the first real request is not slow
    noise = (np.random.default_rng(0).standard_normal(PAD) * 0.01).astype(np.float32)
    for _ in range(3):
        model.recognize(noise, sample_rate=SR)
    log.info("loaded %s (%s) in %.1fs", MODEL_ID, quant, time.perf_counter() - t)
    return model


@asynccontextmanager
async def lifespan(app):
    state["model"] = load()
    state["ready"] = True
    yield


app = FastAPI(title="gpu-speech STT", lifespan=lifespan)


@app.get("/health")
def health():
    if not state["ready"]:
        return JSONResponse({"status": "loading"}, status_code=503)
    return {"status": "ok", "model": MODEL_ID}


@app.get("/v1/models")
def models():
    return {"object": "list", "data": [{"id": MODEL_ID, "object": "model", "owned_by": "nvidia"}]}


def decode(data: bytes) -> np.ndarray:
    try:
        audio, sr = sf.read(io.BytesIO(data), dtype="float32", always_2d=True)
    except Exception as e:
        raise HTTPException(400, f"cannot decode audio (send WAV/FLAC/OGG): {e}")
    audio = audio.mean(axis=1)
    return soxr.resample(audio, sr, SR) if sr != SR else audio


@app.post("/v1/audio/transcriptions")
def transcriptions(file: UploadFile = File(...), model: str = Form(None), language: str = Form(None),
                   prompt: str = Form(None), response_format: str = Form("json"),
                   temperature: float = Form(None)):
    # `model`, `prompt` and `temperature` are accepted for OpenAI compatibility and ignored
    if language and not language.lower().startswith("en"):
        raise HTTPException(400, f"English only (got language={language!r})")
    t0 = time.perf_counter()
    audio = decode(file.file.read())
    dur = len(audio) / SR
    text = ""
    if dur >= 0.1:
        audio = np.pad(audio, (0, -len(audio) % PAD))
        with gpu:
            text = state["model"].recognize(audio, sample_rate=SR).strip()
    ms = (time.perf_counter() - t0) * 1000
    log.info("%.2fs audio -> %.0f ms: %r", dur, ms, text)
    headers = {"X-Processing-Ms": f"{ms:.1f}"}
    if response_format == "text":
        return PlainTextResponse(text, headers=headers)
    body = {"text": text}
    if response_format == "verbose_json":
        body.update(language="english", duration=round(dur, 3))
    return JSONResponse(body, headers=headers)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("STT_PORT", 8401)), log_level="warning")

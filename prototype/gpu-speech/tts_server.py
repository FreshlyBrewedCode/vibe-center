"""TTS server: Kokoro-82M (official `kokoro` package, torch CUDA) behind an OpenAI-compatible
POST /v1/audio/speech that streams raw s16le mono 24 kHz PCM, one chunk per sentence. English only."""
import logging, os, re, struct, threading, time
from contextlib import asynccontextmanager

import numpy as np, torch
import common  # noqa: F401  (logging setup)
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse, StreamingResponse
from huggingface_hub import snapshot_download
from kokoro import KModel, KPipeline
from pydantic import BaseModel

log = logging.getLogger("tts")
SR = 24000
REPO = "hexgrad/Kokoro-82M"
DEFAULT_VOICE = os.environ.get("TTS_VOICE", "af_heart")
state = {"ready": False}
gpu = threading.Lock()  # one synthesis step at a time on the GPU

# Sentence ends and line breaks. A long first sentence is also cut at its first clause
# break (see chunks()), so the first audio arrives sooner.
SENTENCE = re.compile(r"(?<=[.!?…])[\"')\]]*\s+|\n+")
CLAUSE = re.compile(r"(?<=[,;:—])\s+")
FIRST_CHUNK_MAX_WORDS = 12


def chunks(text):
    parts = [s.strip() for s in SENTENCE.split(text) if s and s.strip()]
    if parts and len(parts[0].split()) > FIRST_CHUNK_MAX_WORDS:
        first = parts[0]
        for m in CLAUSE.finditer(first):
            head = first[:m.start()]
            if 4 <= len(head.split()) <= FIRST_CHUNK_MAX_WORDS:
                parts[:1] = [head, first[m.end():]]
                break
    return parts


def load():
    t = time.perf_counter()
    path = snapshot_download(REPO, allow_patterns=["config.json", "kokoro-v1_0.pth", "voices/*"])
    voices = sorted(f[:-3] for f in os.listdir(os.path.join(path, "voices"))
                    if f.endswith(".pt") and f[:2] in ("af", "am", "bf", "bm"))
    model = KModel(repo_id=REPO).to("cuda").eval()
    # American (a*) and British (b*) English share the model
    pipes = {lang: KPipeline(lang_code=lang, repo_id=REPO, model=model) for lang in "ab"}
    for v in voices:
        pipes[v[0]].load_voice(v)
    state.update(voices=voices, pipes=pipes)
    for text in ("Warming up.", "Warming up the voice, with a slightly longer sentence than before."):
        for v in {DEFAULT_VOICE, "bf_emma"} & set(voices):
            list(synth(text, v, 1.0))
    log.info("loaded Kokoro-82M with %d voices in %.1fs", len(voices), time.perf_counter() - t)


def synth(text, voice, speed):
    """Yields float32 audio per chunk of text."""
    pipe = state["pipes"][voice[0]]
    for part in chunks(text):
        with gpu:  # not held while the caller sends the chunk
            audio = [r.audio.cpu().numpy() for r in pipe(part, voice=voice, speed=speed, split_pattern=None)
                     if r.audio is not None]
        yield from audio


def to_s16(a):
    return (np.clip(a, -1.0, 1.0) * 32767).astype("<i2").tobytes()


def wav_header():
    # streaming WAV: sizes unknown up front, so max them out (players read to EOF)
    return (b"RIFF" + struct.pack("<I", 0xFFFFFFFF) + b"WAVEfmt " +
            struct.pack("<IHHIIHH", 16, 1, 1, SR, SR * 2, 2, 16) + b"data" + struct.pack("<I", 0xFFFFFFFF))


@asynccontextmanager
async def lifespan(app):
    load()
    state["ready"] = True
    yield


app = FastAPI(title="gpu-speech TTS", lifespan=lifespan)


class SpeechRequest(BaseModel):
    input: str
    voice: str = DEFAULT_VOICE
    model: str | None = None  # accepted, ignored: always Kokoro-82M
    response_format: str = "pcm"
    speed: float = 1.0


@app.get("/health")
def health():
    if not state["ready"]:
        return JSONResponse({"status": "loading"}, status_code=503)
    return {"status": "ok", "model": "kokoro-82m", "sample_rate": SR}


@app.get("/v1/audio/voices")
@app.get("/voices")
def voices():
    return {"voices": state.get("voices", []), "default": DEFAULT_VOICE}


@app.post("/v1/audio/speech")
def speech(req: SpeechRequest):
    if req.voice not in state["voices"]:
        raise HTTPException(400, f"unknown voice {req.voice!r}; see /v1/audio/voices")
    if req.response_format not in ("pcm", "wav"):
        raise HTTPException(400, "response_format must be 'pcm' (s16le mono 24 kHz) or 'wav'")
    if not 0.5 <= req.speed <= 2.0:
        raise HTTPException(400, "speed must be within 0.5..2.0")
    text = req.input.strip()
    if not text:
        raise HTTPException(400, "empty input")

    def stream():
        t0 = time.perf_counter(); first = None; samples = 0
        if req.response_format == "wav":
            yield wav_header()
        try:
            for a in synth(text, req.voice, req.speed):
                if first is None:
                    first = (time.perf_counter() - t0) * 1000
                samples += len(a)
                yield to_s16(a)
        finally:
            total = (time.perf_counter() - t0) * 1000
            log.info("%d chars, %s: first audio %s ms, %.2fs audio in %.0f ms", len(text), req.voice,
                     f"{first:.0f}" if first is not None else "-", samples / SR, total)

    media = "audio/wav" if req.response_format == "wav" else "audio/pcm"
    return StreamingResponse(stream(), media_type=media,
                             headers={"X-Sample-Rate": str(SR), "X-Audio-Format": "s16le-mono"})


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("TTS_PORT", 8402)), log_level="warning")

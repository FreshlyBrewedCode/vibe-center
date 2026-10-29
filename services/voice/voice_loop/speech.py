"""STT/TTS backends: OpenAI-compatible HTTP servers (GPU on km-pc via tunnel) or local CPU.

Each service marks stt_*/tts_* timestamps on the call's TurnLog.
"""

from __future__ import annotations

import asyncio
import io
import wave
from collections.abc import AsyncGenerator

import httpx
import numpy as np
from loguru import logger

from pipecat.frames.frames import ErrorFrame, Frame, TranscriptionFrame, TTSAudioRawFrame
from pipecat.services.stt_service import SegmentedSTTService
from pipecat.services.settings import STTSettings, TTSSettings
from pipecat.services.tts_service import TTSService
from pipecat.transcriptions.language import Language
from pipecat.utils.text.transforms.strip_markdown import strip_markdown
from pipecat.utils.time import time_now_iso8601

from .config import CONFIG, Config
from .latency import TurnLog, now_ms

TTS_SAMPLE_RATE = 24000
TEXT_TRANSFORMS = [("*", strip_markdown)]


def http_healthy(cfg: Config = CONFIG, timeout: float = 1.5) -> dict[str, bool]:
    out = {}
    for name, url in (("stt", cfg.stt_url), ("tts", cfg.tts_url)):
        try:
            out[name] = httpx.get(f"{url}/health", timeout=timeout).status_code == 200
        except Exception:
            out[name] = False
    return out


def resolve_backend(cfg: Config = CONFIG) -> str:
    if cfg.speech_backend in ("http", "local"):
        return cfg.speech_backend
    h = http_healthy(cfg)
    backend = "http" if all(h.values()) else "local"
    logger.info(f"speech backend auto -> {backend} (health {h})")
    return backend


# ---- STT -------------------------------------------------------------------------------------


class HttpSTTService(SegmentedSTTService):
    """One POST /v1/audio/transcriptions per VAD-gated segment (16 kHz mono WAV).

    If the server can't be reached (km-pc asleep, tunnel down), the segment is transcribed with
    the local CPU Whisper instead, so the turn isn't lost.
    """

    def __init__(self, *, base_url: str, model: str, log: TurnLog | None = None, cfg: Config = CONFIG, **kwargs):
        super().__init__(settings=STTSettings(model=model, language=Language.EN), **kwargs)
        self._url = f"{base_url}/v1/audio/transcriptions"
        self._model = model
        self._log = log
        self._cfg = cfg
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(10.0, connect=1.0))

    def can_generate_metrics(self) -> bool:
        return True

    async def run_stt(self, audio: bytes) -> AsyncGenerator[Frame, None]:
        if self._log:
            self._log.set("stt_request")
        try:
            r = await self._client.post(
                self._url,
                files={"file": ("audio.wav", audio, "audio/wav")},
                data={"model": self._model, "language": "en", "response_format": "json"},
            )
            r.raise_for_status()
            text = (r.json().get("text") or "").strip()
        except (httpx.TransportError, httpx.HTTPStatusError) as e:
            logger.warning(f"HTTP STT failed ({e!r}); falling back to local whisper")
            if self._log:
                self._log.info(stt_fallback=repr(e))
            text = await asyncio.to_thread(self._local_transcribe, audio)
        if self._log:
            self._log.set("stt_response")
        if text:
            yield TranscriptionFrame(text, self._user_id, time_now_iso8601(), Language.EN)

    def _local_transcribe(self, wav: bytes) -> str:
        with wave.open(io.BytesIO(wav)) as w:
            pcm = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768
        segments, _ = _whisper_model(self._cfg.whisper_model, "cpu", "int8").transcribe(pcm, language="en")
        return " ".join(s.text.strip() for s in segments).strip()

    async def cleanup(self):
        await super().cleanup()
        await self._client.aclose()


# Models are loaded once per process and shared by all calls: loading per call costs seconds
# (faster-whisper also asks the HF Hub every time), and audio sent before the pipeline is up is lost.
_MODELS: dict = {}


def _whisper_model(name: str, device: str, compute_type: str):
    from faster_whisper import WhisperModel

    key = ("whisper", name, device, compute_type)
    if key not in _MODELS:
        _MODELS[key] = WhisperModel(name, device=device, compute_type=compute_type)
    return _MODELS[key]


def _kokoro_model(model_path: str, voices_path: str):
    from kokoro_onnx import Kokoro

    key = ("kokoro", model_path, voices_path)
    if key not in _MODELS:
        _MODELS[key] = Kokoro(model_path, voices_path)
    return _MODELS[key]


def preload(backend: str, cfg: Config = CONFIG) -> None:
    """Load the local models up front (server start), so the first call starts at once.
    With the HTTP backend they are the fallback when km-pc can't be reached."""
    import pipecat.services.kokoro.tts as kokoro_tts
    from pipecat.services.kokoro.tts import KOKORO_CACHE_DIR, _ensure_model_files

    _whisper_model(cfg.whisper_model, "cpu", "int8")
    model, voices = KOKORO_CACHE_DIR / "kokoro-v1.0.onnx", KOKORO_CACHE_DIR / "voices-v1.0.bin"
    _ensure_model_files(model, voices)
    _kokoro_model(str(model), str(voices))
    kokoro_tts.Kokoro = _kokoro_model  # KokoroTTSService instantiates through this name


def make_local_stt(cfg: Config, log: TurnLog):
    from pipecat.services.whisper.stt import WhisperSTTService

    class MarkedWhisperSTT(WhisperSTTService):
        def _load(self):
            self._model = _whisper_model(self._settings.model, self._device, self._compute_type)

        async def run_stt(self, audio: bytes) -> AsyncGenerator[Frame, None]:
            log.set("stt_request")
            async for f in super().run_stt(audio):
                log.set("stt_response")
                yield f

    return MarkedWhisperSTT(
        settings=WhisperSTTService.Settings(model=cfg.whisper_model, language=Language.EN),
        device="cpu",
        compute_type="int8",
    )


def make_stt(backend: str, cfg: Config, log: TurnLog):
    if backend == "http":
        return HttpSTTService(base_url=cfg.stt_url, model=cfg.stt_http_model, log=log, cfg=cfg)
    return make_local_stt(cfg, log)


# ---- TTS -------------------------------------------------------------------------------------


class SilenceTrimmer:
    """Streaming trim of a sentence's leading and trailing silence (s16le mono 24 kHz).

    The GPU Kokoro server pads every sentence with ~350 ms of silence in front and ~500 ms
    behind; untrimmed, that is heard as extra latency before each reply and slow gaps between
    sentences. Keeps `lead_ms` before the first sound and at most `tail_ms` after the last.
    """

    def __init__(self, threshold: int = 330, lead_ms: int = 30, tail_ms: int = 120):
        self.threshold = threshold
        self.lead = int(TTS_SAMPLE_RATE * lead_ms / 1000)
        self.tail = int(TTS_SAMPLE_RATE * tail_ms / 1000)
        self.started = False
        self.pre = np.zeros(0, np.int16)  # quiet audio before the first sound
        self.hold = np.zeros(0, np.int16)  # quiet audio after the latest sound

    def feed(self, data: bytes) -> bytes:
        a = np.frombuffer(data, np.int16)
        loud = np.flatnonzero(np.abs(a) > self.threshold)
        if not self.started:
            if not len(loud):
                self.pre = np.concatenate([self.pre, a])[-self.lead :]
                return b""
            self.started = True
            first = len(self.pre) + loud[0]
            a = np.concatenate([self.pre, a])[max(0, first - self.lead) :]
            loud = np.flatnonzero(np.abs(a) > self.threshold)
        if not len(loud):
            self.hold = np.concatenate([self.hold, a])
            return b""
        out = np.concatenate([self.hold, a[: loud[-1] + 1]])
        self.hold = a[loud[-1] + 1 :]
        return out.tobytes()

    def end(self) -> bytes:
        return self.hold[: self.tail].tobytes() if self.started else b""


class HttpTTSService(TTSService):
    """POST /v1/audio/speech with response_format=pcm; streams raw s16le mono 24 kHz.

    If the server can't be reached, the sentence is synthesized with local kokoro-onnx instead.
    """

    def __init__(self, *, base_url: str, model: str, voice: str, **kwargs):
        super().__init__(
            push_start_frame=True,
            push_stop_frames=True,
            sample_rate=TTS_SAMPLE_RATE,
            settings=TTSSettings(model=model, voice=voice, language=Language.EN),
            **kwargs,
        )
        self._url = f"{base_url}/v1/audio/speech"
        self._model = model
        self._voice = voice
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(30.0, connect=1.0))

    def can_generate_metrics(self) -> bool:
        return True

    async def run_tts(self, text: str, context_id: str) -> AsyncGenerator[Frame, None]:
        await self.start_tts_usage_metrics(text)
        body = {"model": self._model, "input": text, "voice": self._voice, "response_format": "pcm"}
        try:
            async with self._client.stream("POST", self._url, json=body) as r:
                if r.status_code != 200:
                    yield ErrorFrame(error=f"HTTP TTS {r.status_code}: {(await r.aread())[:200]!r}")
                    return
                trim = SilenceTrimmer()
                rest = b""
                async for chunk in r.aiter_bytes():
                    buf = rest + chunk
                    n = len(buf) - (len(buf) % 2)
                    rest = buf[n:]
                    audio = trim.feed(buf[:n])
                    if audio:
                        await self.stop_ttfb_metrics()
                        yield TTSAudioRawFrame(audio=audio, sample_rate=TTS_SAMPLE_RATE, num_channels=1, context_id=context_id)
                tail = trim.end()
                if tail:
                    yield TTSAudioRawFrame(audio=tail, sample_rate=TTS_SAMPLE_RATE, num_channels=1, context_id=context_id)
        except httpx.TransportError as e:
            logger.warning(f"HTTP TTS failed ({e!r}); falling back to local kokoro")
            pcm = await asyncio.to_thread(synth_pcm, text, "local", self._voice)
            yield TTSAudioRawFrame(audio=pcm, sample_rate=TTS_SAMPLE_RATE, num_channels=1, context_id=context_id)

    async def cleanup(self):
        await super().cleanup()
        await self._client.aclose()


def _marked_tts(cls):
    """Subclass a TTS service so it marks tts_request / tts_first_audio on the turn log."""

    class Marked(cls):
        def __init__(self, *a, log: TurnLog, **kw):
            super().__init__(*a, **kw)
            self._vl_log = log

        async def run_tts(self, text: str, context_id: str) -> AsyncGenerator[Frame, None]:
            self._vl_log.mark("tts_request")
            self._vl_log.add("tts_sentences", {"t": now_ms(), "text": text})
            async for f in super().run_tts(text, context_id):
                if isinstance(f, TTSAudioRawFrame):
                    self._vl_log.mark("tts_first_audio")
                yield f

    Marked.__name__ = f"Marked{cls.__name__}"
    return Marked


def make_tts(backend: str, cfg: Config, log: TurnLog):
    if backend == "http":
        return _marked_tts(HttpTTSService)(
            base_url=cfg.tts_url,
            model=cfg.tts_http_model,
            voice=cfg.tts_voice,
            log=log,
            text_transforms=TEXT_TRANSFORMS,
        )
    from pipecat.services.kokoro.tts import KokoroTTSService

    return _marked_tts(KokoroTTSService)(
        settings=KokoroTTSService.Settings(voice=cfg.tts_voice, language=Language.EN),
        sample_rate=TTS_SAMPLE_RATE,
        log=log,
        text_transforms=TEXT_TRANSFORMS,
    )


# ---- one-shot synthesis (cues, test utterances) ----------------------------------------------

def synth_pcm(text: str, backend: str, voice: str, cfg: Config = CONFIG) -> bytes:
    """Synthesize text to s16le mono 24 kHz PCM, blocking."""
    if backend == "http":
        r = httpx.post(
            f"{cfg.tts_url}/v1/audio/speech",
            json={"model": cfg.tts_http_model, "input": text, "voice": voice, "response_format": "pcm"},
            timeout=60,
        )
        r.raise_for_status()
        return r.content
    import numpy as np
    from pipecat.services.kokoro.tts import KOKORO_CACHE_DIR, _ensure_model_files

    model, voices = KOKORO_CACHE_DIR / "kokoro-v1.0.onnx", KOKORO_CACHE_DIR / "voices-v1.0.bin"
    _ensure_model_files(model, voices)
    samples, sr = _kokoro_model(str(model), str(voices)).create(text, voice=voice, speed=1.0, lang="en-us")
    assert sr == TTS_SAMPLE_RATE, sr
    return (np.clip(samples, -1, 1) * 32767).astype(np.int16).tobytes()


def pcm_to_wav_bytes(pcm: bytes, sample_rate: int = TTS_SAMPLE_RATE) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm)
    return buf.getvalue()

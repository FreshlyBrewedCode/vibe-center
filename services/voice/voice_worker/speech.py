"""STT/TTS: OpenAI-compatible HTTP servers (the GPU servers on km-pc, via tunnels) or local CPU.

Each call picks HTTP for STT and TTS separately when the URL is set and its /health answers;
otherwise the local CPU models (faster-whisper, kokoro-onnx). An HTTP request that can't
connect falls back to the CPU model, so a sleeping km-pc never loses a turn.
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
from pipecat.services.settings import STTSettings, TTSSettings
from pipecat.services.stt_service import SegmentedSTTService
from pipecat.services.tts_service import TTSService
from pipecat.transcriptions.language import Language
from pipecat.utils.text.transforms.strip_markdown import strip_markdown
from pipecat.utils.time import time_now_iso8601

from .config import CONFIG
from .latency import TurnLog, now_ms
from .turns import TurnRecorder, TurnTranscriptionMixin

TTS_SAMPLE_RATE = 24000
TEXT_TRANSFORMS = [("*", strip_markdown)]
HTTP_MODEL = "default"  # the GPU servers ignore it


def healthy(url: str, timeout: float = 0.8) -> bool:
    if not url:
        return False
    try:
        return httpx.get(f"{url.rstrip('/')}/health", timeout=timeout).status_code == 200
    except Exception:
        return False


# ---- local models ----------------------------------------------------------------------------

# Loaded once per process and shared by all calls: loading per call costs seconds (faster-whisper
# also asks the HF Hub every time), and audio sent before the pipeline is up is lost.
_MODELS: dict = {}


def _whisper_model(name: str, device: str = "cpu", compute_type: str = "int8"):
    from faster_whisper import WhisperModel

    key = ("whisper", name, device, compute_type)
    if key not in _MODELS:
        _MODELS[key] = WhisperModel(name, device=device, compute_type=compute_type)
    return _MODELS[key]


def _kokoro_files():
    from pipecat.services.kokoro.tts import KOKORO_CACHE_DIR, _ensure_model_files

    model, voices = KOKORO_CACHE_DIR / "kokoro-v1.0.onnx", KOKORO_CACHE_DIR / "voices-v1.0.bin"
    _ensure_model_files(model, voices)
    return str(model), str(voices)


def _kokoro_model(model_path: str, voices_path: str):
    from kokoro_onnx import Kokoro

    key = ("kokoro", model_path, voices_path)
    if key not in _MODELS:
        _MODELS[key] = Kokoro(model_path, voices_path)
    return _MODELS[key]


def local_kokoro():
    return _kokoro_model(*_kokoro_files())


def preload() -> None:
    """Load the CPU models up front (worker start), so the first call starts at once. With the
    HTTP servers they are the per-request fallback."""
    import pipecat.services.kokoro.tts as kokoro_tts

    _whisper_model(CONFIG.whisper_model)
    local_kokoro()
    kokoro_tts.Kokoro = _kokoro_model  # KokoroTTSService instantiates through this name


def local_voices() -> list[str]:
    """English voices of the CPU Kokoro (same names as the GPU server's)."""
    return sorted(v for v in local_kokoro().get_voices() if v[:2] in ("af", "am", "bf", "bm"))


def local_voice(voice: str) -> str:
    return voice if voice in local_voices() else CONFIG.default_voice


# ---- STT -------------------------------------------------------------------------------------


class HttpSTTService(TurnTranscriptionMixin, SegmentedSTTService):
    """One POST /v1/audio/transcriptions per VAD stop with the whole turn so far (16 kHz mono
    WAV; see turns.py), with the local Whisper as fallback when the server can't be reached.
    `vocabulary` goes out as the OpenAI `prompt`: the server applies it where its model can."""

    def __init__(self, *, base_url: str, log: TurnLog, vocabulary: list[str] | None = None, **kwargs):
        super().__init__(settings=STTSettings(model=HTTP_MODEL, language=Language.EN), **kwargs)
        self._url = f"{base_url.rstrip('/')}/v1/audio/transcriptions"
        self._log = log
        self._vocabulary = vocabulary or []
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(10.0, connect=1.0))

    def can_generate_metrics(self) -> bool:
        return True

    async def run_stt(self, audio: bytes) -> AsyncGenerator[Frame, None]:
        self._log.set("stt_request")
        data = {"model": HTTP_MODEL, "language": "en", "response_format": "verbose_json"}
        if self._vocabulary:
            data["prompt"] = vocabulary_prompt(self._vocabulary)
        try:
            r = await self._client.post(
                self._url, files={"file": ("audio.wav", audio, "audio/wav")}, data=data
            )
            r.raise_for_status()
            body = r.json()
            text = (body.get("text") or "").strip()
            if body.get("model"):
                self._log.info(stt_model=body["model"])
        except (httpx.TransportError, httpx.HTTPStatusError) as e:
            logger.warning(f"HTTP STT failed ({e!r}); falling back to local whisper")
            self._log.info(stt_fallback=repr(e))
            text = await asyncio.to_thread(_local_transcribe, wav_to_pcm(audio), self._vocabulary)
        self._log.set("stt_response")
        if text:
            yield TranscriptionFrame(text, self._user_id, time_now_iso8601(), Language.EN)

    async def cleanup(self):
        await super().cleanup()
        await self._client.aclose()


class LocalWhisperSTTService(TurnTranscriptionMixin, SegmentedSTTService):
    """The CPU fallback: faster-whisper (CONFIG.whisper_model, int8) in this process, with the
    vocabulary as hotwords."""

    def __init__(self, *, log: TurnLog, vocabulary: list[str] | None = None, **kwargs):
        super().__init__(settings=STTSettings(model=CONFIG.whisper_model, language=Language.EN), **kwargs)
        self._log = log
        self._vocabulary = vocabulary or []

    @property
    def wants_wav_segments(self) -> bool:
        return False

    def can_generate_metrics(self) -> bool:
        return True

    async def run_stt(self, audio: bytes) -> AsyncGenerator[Frame, None]:
        self._log.set("stt_request")
        text = await asyncio.to_thread(_local_transcribe, audio, self._vocabulary)
        self._log.set("stt_response")
        if text:
            yield TranscriptionFrame(text, self._user_id, time_now_iso8601(), Language.EN)


def vocabulary_prompt(terms: list[str]) -> str:
    return ", ".join(t.strip() for t in terms if t.strip())


def wav_to_pcm(wav: bytes) -> bytes:
    with wave.open(io.BytesIO(wav)) as w:
        return w.readframes(w.getnframes())


def _local_transcribe(pcm: bytes, vocabulary: list[str] | None = None) -> str:
    audio = np.frombuffer(pcm, np.int16).astype(np.float32) / 32768
    segments, _ = _whisper_model(CONFIG.whisper_model).transcribe(
        audio,
        language="en",
        hotwords=vocabulary_prompt(vocabulary) if vocabulary else None,
        condition_on_previous_text=False,
    )
    return " ".join(s.text.strip() for s in segments).strip()


def make_stt(
    stt_url: str | None,
    log: TurnLog,
    *,
    vocabulary: list[str] | None = None,
    recorder: TurnRecorder | None = None,
):
    if stt_url:
        return HttpSTTService(base_url=stt_url, log=log, vocabulary=vocabulary, recorder=recorder)
    return LocalWhisperSTTService(log=log, vocabulary=vocabulary, recorder=recorder)


# ---- TTS -------------------------------------------------------------------------------------


class HttpTTSService(TTSService):
    """POST /v1/audio/speech with response_format=pcm; streams raw s16le mono 24 kHz. The server
    trims each sentence's silence itself. Falls back to local kokoro-onnx if it can't be reached."""

    def __init__(self, *, base_url: str, voice: str, **kwargs):
        super().__init__(
            push_start_frame=True,
            push_stop_frames=True,
            sample_rate=TTS_SAMPLE_RATE,
            settings=TTSSettings(model=HTTP_MODEL, voice=voice, language=Language.EN),
            **kwargs,
        )
        self._url = f"{base_url.rstrip('/')}/v1/audio/speech"
        self._voice = voice
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(30.0, connect=1.0))

    def can_generate_metrics(self) -> bool:
        return True

    async def run_tts(self, text: str, context_id: str) -> AsyncGenerator[Frame, None]:
        await self.start_tts_usage_metrics(text)
        body = {"model": HTTP_MODEL, "input": text, "voice": self._voice, "response_format": "pcm"}
        try:
            async with self._client.stream("POST", self._url, json=body) as r:
                if r.status_code != 200:
                    yield ErrorFrame(error=f"HTTP TTS {r.status_code}: {(await r.aread())[:200]!r}")
                    return
                rest = b""
                async for chunk in r.aiter_bytes():
                    buf = rest + chunk
                    n = len(buf) - (len(buf) % 2)
                    rest = buf[n:]
                    if n:
                        await self.stop_ttfb_metrics()
                        yield TTSAudioRawFrame(
                            audio=buf[:n], sample_rate=TTS_SAMPLE_RATE, num_channels=1, context_id=context_id
                        )
        except httpx.TransportError as e:
            logger.warning(f"HTTP TTS failed ({e!r}); falling back to local kokoro")
            pcm = await asyncio.to_thread(synth_pcm, text, None, self._voice)
            yield TTSAudioRawFrame(
                audio=pcm, sample_rate=TTS_SAMPLE_RATE, num_channels=1, context_id=context_id
            )

    async def cleanup(self):
        await super().cleanup()
        await self._client.aclose()


def _marked_tts(cls):
    """Subclass a TTS service so it marks tts_request / tts_first_audio on the turn log."""

    class Marked(cls):
        def __init__(self, *a, log: TurnLog, **kw):
            super().__init__(*a, **kw)
            self._vc_log = log

        async def run_tts(self, text: str, context_id: str) -> AsyncGenerator[Frame, None]:
            self._vc_log.mark("tts_request")
            self._vc_log.add("tts_sentences", {"t": now_ms(), "text": text})
            async for f in super().run_tts(text, context_id):
                if isinstance(f, TTSAudioRawFrame):
                    self._vc_log.mark("tts_first_audio")
                yield f

    Marked.__name__ = f"Marked{cls.__name__}"
    return Marked


def make_tts(tts_url: str | None, voice: str, log: TurnLog):
    if tts_url:
        return _marked_tts(HttpTTSService)(
            base_url=tts_url, voice=voice, log=log, text_transforms=TEXT_TRANSFORMS
        )
    from pipecat.services.kokoro.tts import KokoroTTSService

    return _marked_tts(KokoroTTSService)(
        settings=KokoroTTSService.Settings(voice=local_voice(voice), language=Language.EN),
        sample_rate=TTS_SAMPLE_RATE,
        log=log,
        text_transforms=TEXT_TRANSFORMS,
    )


# ---- one-shot synthesis (cues, voice preview, test audio) ------------------------------------


def synth_pcm(text: str, tts_url: str | None, voice: str) -> bytes:
    """Synthesize text to s16le mono 24 kHz PCM, blocking. tts_url None = local kokoro-onnx."""
    if tts_url:
        r = httpx.post(
            f"{tts_url.rstrip('/')}/v1/audio/speech",
            json={"model": HTTP_MODEL, "input": text, "voice": voice, "response_format": "pcm"},
            timeout=60,
        )
        r.raise_for_status()
        return r.content
    samples, sr = local_kokoro().create(text, voice=local_voice(voice), speed=1.0, lang="en-us")
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

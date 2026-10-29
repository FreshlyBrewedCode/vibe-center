"""Runtime configuration, all from environment variables (see README)."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _env(name: str, default: str) -> str:
    return os.environ.get(name, default)


@dataclass
class Config:
    # "auto": HTTP GPU servers when both /health are OK, else local CPU. "http" | "local" force one.
    speech_backend: str = field(default_factory=lambda: _env("SPEECH_BACKEND", "auto"))
    stt_url: str = field(default_factory=lambda: _env("STT_URL", "http://127.0.0.1:8401"))
    tts_url: str = field(default_factory=lambda: _env("TTS_URL", "http://127.0.0.1:8402"))
    stt_http_model: str = field(default_factory=lambda: _env("STT_HTTP_MODEL", "default"))
    tts_http_model: str = field(default_factory=lambda: _env("TTS_HTTP_MODEL", "default"))
    tts_voice: str = field(default_factory=lambda: _env("TTS_VOICE", "af_heart"))
    # local fallbacks
    whisper_model: str = field(default_factory=lambda: _env("WHISPER_MODEL", "base.en"))
    # turn-taking
    vad_stop_secs: float = field(default_factory=lambda: float(_env("VAD_STOP_SECS", "0.2")))
    # cues: ACK = mhm | okay | earcon | off ; FILLER = on | off
    ack: str = field(default_factory=lambda: _env("ACK", "mhm"))
    filler: str = field(default_factory=lambda: _env("FILLER", "on"))
    # talker
    talker_model: str = field(default_factory=lambda: _env("TALKER_MODEL", "haiku"))
    prompt_timeout_s: float = field(default_factory=lambda: float(_env("PROMPT_TIMEOUT_S", "25")))
    warmup: bool = field(default_factory=lambda: _env("WARMUP", "1") == "1")
    # server
    host: str = field(default_factory=lambda: _env("HOST", "127.0.0.1"))
    port: int = field(default_factory=lambda: int(_env("PORT", "7860")))
    log_dir: Path = field(default_factory=lambda: Path(_env("LOG_DIR", str(ROOT / "logs"))))


CONFIG = Config()

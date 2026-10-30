"""Process-level configuration from the environment. The app sets these when it spawns the
worker (managed mode); a remote worker is started by hand with the same variables.

Per-call settings (agent voice, STT/TTS URLs, filler, the bridge URL and its credential) are not
here: the app sends them with each call (`POST /calls`), so a settings change needs no restart.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _env(name: str, default: str) -> str:
    return os.environ.get(name, default)


@dataclass
class Config:
    host: str = field(default_factory=lambda: _env("VC_WORKER_HOST", "127.0.0.1"))
    port: int = field(default_factory=lambda: int(_env("VC_WORKER_PORT", "7860")))
    # Bearer token the app must send on every request. Required.
    token: str = field(default_factory=lambda: _env("VC_WORKER_TOKEN", ""))
    # call logs (calls/*.jsonl) and the cue cache (cues/)
    data_dir: Path = field(
        default_factory=lambda: Path(_env("VC_VOICE_DATA_DIR", str(Path.home() / ".vibe-center" / "voice")))
    )
    # CPU fallbacks (always loaded: they cover a GPU server that is asleep or unreachable)
    whisper_model: str = field(default_factory=lambda: _env("WHISPER_MODEL", "base.en"))
    # turn-taking: Silero silence before Smart Turn v3 decides (Pipecat's recommended value)
    vad_stop_secs: float = field(default_factory=lambda: float(_env("VAD_STOP_SECS", "0.2")))
    # a voice turn that hasn't finished after this long is cancelled with a spoken apology
    prompt_timeout_s: float = field(default_factory=lambda: float(_env("PROMPT_TIMEOUT_S", "45")))
    default_voice: str = field(default_factory=lambda: _env("TTS_VOICE", "af_heart"))

    @property
    def log_dir(self) -> Path:
        return self.data_dir / "calls"

    @property
    def cue_dir(self) -> Path:
        return self.data_dir / "cues"

    @property
    def recordings_dir(self) -> Path:
        return self.data_dir / "recordings"


@dataclass
class CallConfig:
    """What the app sends with `POST /calls`."""

    call_id: str
    bridge_url: str
    bridge_token: str
    agent_name: str = "agent"
    voice: str = "af_heart"
    stt_url: str = ""
    tts_url: str = ""
    filler: bool = True
    # terms the STT should recognise (settings + agent names); used where the model supports it
    vocabulary: list[str] = field(default_factory=list)
    # debug: keep the last N user turns as audio + transcript (0 = off)
    record_turns: int = 0


CONFIG = Config()

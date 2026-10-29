"""Pre-synthesized filler cues ("One sec.", "Let me check.", ...), played when a tool call starts
before the agent said anything.

Synthesized once per voice with the local kokoro-onnx (same voices as the GPU server, no network
round trip, works with km-pc asleep) and cached as raw PCM (s16le mono 24 kHz) in <data>/cues/.
There is deliberately no end-of-turn acknowledgement: the end of the user's turn is silent.
"""

from __future__ import annotations

import hashlib
import struct
from pathlib import Path

from loguru import logger

from .speech import TTS_SAMPLE_RATE, synth_pcm

FILLERS = ["One sec.", "Let me check.", "Checking now.", "Hang on."]


def trim(pcm: bytes, threshold: int = 300, pad_ms: int = 30) -> bytes:
    """Trim leading/trailing near-silence so a cue starts the instant it is played."""
    n = len(pcm) // 2
    if n == 0:
        return b""
    samples = struct.unpack(f"<{n}h", pcm[: n * 2])
    first = next((i for i, s in enumerate(samples) if abs(s) > threshold), 0)
    last = next((i for i in range(n - 1, -1, -1) if abs(samples[i]) > threshold), n - 1)
    pad = int(TTS_SAMPLE_RATE * pad_ms / 1000)
    return pcm[max(0, first - pad) * 2 : min(n, last + pad) * 2]


class Cues:
    def __init__(self, cache_dir: Path, voice: str, enabled: bool = True):
        self.cache_dir = cache_dir
        self.voice = voice
        self.enabled = enabled
        self.fillers: list[bytes] = []
        self._next = 0

    def _cached(self, text: str) -> bytes:
        key = hashlib.sha1(f"local|{self.voice}|{text}".encode()).hexdigest()[:12]
        path = self.cache_dir / f"{key}.pcm"
        if path.exists():
            return path.read_bytes()
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        pcm = trim(synth_pcm(text, None, self.voice))
        path.write_bytes(pcm)
        logger.info(
            f"cached cue {text!r} ({len(pcm) / 2 / TTS_SAMPLE_RATE:.2f}s, {self.voice}) -> {path.name}"
        )
        return pcm

    def load(self) -> Cues:
        if self.enabled:
            self.fillers = [self._cached(t) for t in FILLERS]
        return self

    def filler(self) -> tuple[str, bytes] | None:
        """The next filler, rotating, or None when fillers are off."""
        if not self.fillers:
            return None
        i = self._next % len(self.fillers)
        self._next += 1
        return FILLERS[i], self.fillers[i]

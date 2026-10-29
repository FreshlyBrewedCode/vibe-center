"""Pre-synthesized local audio cues: the end-of-turn acknowledgement and tool-call fillers.

Synthesized once with the local kokoro-onnx (same Kokoro voice as the GPU server, but it renders
"Mm-hmm." recognisably and without the server's silence padding), cached as raw PCM (s16le mono
24 kHz) in assets/cues/, so playing one costs no TTS round trip and works with km-pc asleep.
ACK=mhm|okay|earcon|off picks the acknowledgement; FILLER=on|off the fillers.
"""

from __future__ import annotations

import hashlib
import math
import struct
from pathlib import Path

from loguru import logger

from .config import CONFIG, ROOT, Config
from .speech import TTS_SAMPLE_RATE, synth_pcm

CUE_DIR = ROOT / "assets" / "cues"

ACK_TEXT = {"mhm": "Mm-hmm.", "okay": "Okay."}
FILLERS = ["One sec.", "Let me check.", "Checking now.", "Hang on."]


def _earcon(sr: int = TTS_SAMPLE_RATE) -> bytes:
    """A soft rising two-note blip (~220 ms) with fades, low volume."""
    out = []
    for freq, dur in ((587.3, 0.09), (880.0, 0.13)):
        n = int(sr * dur)
        for i in range(n):
            env = min(1.0, i / (0.01 * sr), (n - i) / (0.03 * sr))
            out.append(int(0.18 * 32767 * env * math.sin(2 * math.pi * freq * i / sr)))
    return struct.pack(f"<{len(out)}h", *out)


def _trim(pcm: bytes, threshold: int = 300, pad_ms: int = 30) -> bytes:
    """Trim leading/trailing near-silence so a cue starts the instant it is played."""
    n = len(pcm) // 2
    samples = struct.unpack(f"<{n}h", pcm[: n * 2])
    first = next((i for i, s in enumerate(samples) if abs(s) > threshold), 0)
    last = next((i for i in range(n - 1, -1, -1) if abs(samples[i]) > threshold), n - 1)
    pad = int(TTS_SAMPLE_RATE * pad_ms / 1000)
    return pcm[max(0, first - pad) * 2 : min(n, last + pad) * 2]


class Cues:
    def __init__(self, backend: str, cfg: Config = CONFIG):
        self.backend = backend
        self.cfg = cfg
        self.ack: bytes | None = None
        self.fillers: list[bytes] = []
        self._next_filler = 0

    def _cached(self, text: str) -> bytes:
        key = hashlib.sha1(f"local|{self.cfg.tts_voice}|{text}".encode()).hexdigest()[:12]
        path = CUE_DIR / f"{key}.pcm"
        if path.exists():
            return path.read_bytes()
        CUE_DIR.mkdir(parents=True, exist_ok=True)
        pcm = _trim(synth_pcm(text, "local", self.cfg.tts_voice, self.cfg))
        path.write_bytes(pcm)
        logger.info(f"cached cue {text!r} ({len(pcm) / 2 / TTS_SAMPLE_RATE:.2f}s) -> {path.name}")
        return pcm

    def load(self) -> "Cues":
        ack = self.cfg.ack
        if ack == "earcon":
            self.ack = _earcon()
        elif ack in ACK_TEXT:
            self.ack = self._cached(ACK_TEXT[ack])
        if self.cfg.filler == "on":
            self.fillers = [self._cached(t) for t in FILLERS]
        return self

    def filler(self) -> tuple[str, bytes] | None:
        if not self.fillers:
            return None
        i = self._next_filler % len(self.fillers)
        self._next_filler += 1
        return FILLERS[i], self.fillers[i]

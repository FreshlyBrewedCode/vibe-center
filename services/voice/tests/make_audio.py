"""Synthesize the scenario into one WAV for Chrome's fake mic (--use-file-for-fake-audio-capture).

    uv run python -m tests.make_audio [--backend local|http]  -> tests/out/scenario-<backend>.wav + .json
"""

from __future__ import annotations

import argparse
import json
import wave
from pathlib import Path

import numpy as np
import soxr

from voice_loop.speech import TTS_SAMPLE_RATE, synth_pcm

from .scenario import LEAD_IN, STEPS, TAIL, USER_VOICE

OUT = Path(__file__).resolve().parent / "out"
SR = 48000


def build(backend: str) -> tuple[Path, list[dict]]:
    OUT.mkdir(exist_ok=True)
    wav_path = OUT / f"scenario-{backend}.wav"
    meta_path = OUT / f"scenario-{backend}.json"
    if wav_path.exists() and meta_path.exists():
        return wav_path, json.loads(meta_path.read_text())
    chunks = [np.zeros(int(LEAD_IN * SR), np.int16)]
    t = LEAD_IN
    timeline = []
    for step in STEPS:
        if step.get("event_before"):
            chunks.append(np.zeros(int(step["event_before"] * SR), np.int16))
            timeline.append({"id": "event", "start": t})
            t += step["event_before"]
        pcm = np.frombuffer(synth_pcm(step["text"], backend, USER_VOICE), np.int16).astype(np.float32) / 32768
        pcm = soxr.resample(pcm, TTS_SAMPLE_RATE, SR)
        audio = (np.clip(pcm * 0.9, -1, 1) * 32767).astype(np.int16)
        dur = len(audio) / SR
        timeline.append({"id": step["id"], "text": step["text"], "start": t, "end": t + dur})
        chunks += [audio, np.zeros(int(step["gap"] * SR), np.int16)]
        t += dur + step["gap"]
    chunks.append(np.zeros(int(TAIL * SR), np.int16))
    data = np.concatenate(chunks)
    with wave.open(str(wav_path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(data.tobytes())
    meta = {"duration": len(data) / SR, "timeline": timeline}
    meta_path.write_text(json.dumps(meta, indent=2))
    return wav_path, meta


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--backend", default="local")
    a = ap.parse_args()
    p, m = build(a.backend)
    print(p, json.dumps(m, indent=1))

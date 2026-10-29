"""Synthesize the e2e scenario into one WAV for Chrome's fake mic (--use-file-for-fake-audio-capture).

    ./run.sh python -m tests.make_audio [--out DIR]  -> DIR/scenario.wav + DIR/scenario.json (timeline)

Uses the local kokoro-onnx, so the input audio is the same whatever speech backend the call uses.
Cached: an existing WAV for the same scenario is reused.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import wave
from pathlib import Path

import numpy as np
import soxr

from voice_worker.speech import TTS_SAMPLE_RATE, synth_pcm

from . import scenario
from .scenario import LEAD_IN, STEPS, TAIL, USER_VOICE

OUT = Path(__file__).resolve().parent / "out"
SR = 48000


def build(out: Path = OUT) -> tuple[Path, dict]:
    out.mkdir(parents=True, exist_ok=True)
    key = hashlib.sha1(Path(scenario.__file__).read_bytes()).hexdigest()[:10]
    wav_path, meta_path = out / "scenario.wav", out / "scenario.json"
    if wav_path.exists() and meta_path.exists() and json.loads(meta_path.read_text()).get("key") == key:
        return wav_path, json.loads(meta_path.read_text())
    chunks = [np.zeros(int(LEAD_IN * SR), np.int16)]
    t = LEAD_IN
    timeline = []
    for step in STEPS:
        if step.get("event_before"):
            chunks.append(np.zeros(int(step["event_before"] * SR), np.int16))
            timeline.append({"id": "event", "start": t, "text": scenario.EVENT_TEXT})
            t += step["event_before"]
        pcm = np.frombuffer(synth_pcm(step["text"], None, USER_VOICE), np.int16).astype(np.float32) / 32768
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
    meta = {"key": key, "wav": str(wav_path), "duration": len(data) / SR, "timeline": timeline}
    meta_path.write_text(json.dumps(meta, indent=2))
    return wav_path, meta


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=OUT)
    a = ap.parse_args()
    _, m = build(a.out)
    print(json.dumps(m))

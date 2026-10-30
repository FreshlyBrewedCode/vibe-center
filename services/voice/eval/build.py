"""Synthesize the STT evaluation set (eval/utterances.py) into 16 kHz mono WAVs.

    ./run.sh python -m eval.build [--out eval/out]   -> out/<condition>/<id>.wav + out/manifest.json

Each utterance gets one of 10 Kokoro voices (American and British, female and male) at a speed
between 0.9 and 1.15, a pause at every `|`, 1.5 s of silence before (so a call's pre-roll buffer
is full) and after, and three conditions:

- clean: as synthesized, -23 dBFS RMS
- noisy: pink noise at 15 dB SNR plus babble (other utterances, mixed) at 18 dB SNR
- phone: a far, quiet phone mic: 300-3400 Hz band, -38 dBFS, brown noise at 20 dB SNR

Uses the worker's CPU kokoro-onnx, so it runs on dev. Deterministic (fixed seeds); cached by
the content of utterances.py.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import wave
from pathlib import Path

import numpy as np
import soxr

from voice_worker.speech import TTS_SAMPLE_RATE, local_kokoro

from .utterances import UTTERANCES

SR = 16000
OUT = Path(__file__).resolve().parent / "out"
VOICES = [
    "af_heart",
    "am_michael",
    "bf_emma",
    "bm_george",
    "af_bella",
    "am_fenrir",
    "bf_isabella",
    "bm_lewis",
    "af_nicole",
    "am_puck",
]
CONDITIONS = ("clean", "noisy", "phone")


def synth(text: str, voice: str, speed: float) -> np.ndarray:
    samples, sr = local_kokoro().create(text, voice=voice, speed=speed, lang="en-us")
    assert sr == TTS_SAMPLE_RATE
    return soxr.resample(np.asarray(samples, np.float32), TTS_SAMPLE_RATE, SR)


def trim(a: np.ndarray, thresh: float = 0.01) -> np.ndarray:
    idx = np.flatnonzero(np.abs(a) > thresh)
    return a[max(0, idx[0] - 800) : idx[-1] + 1600] if len(idx) else a


def rms(a: np.ndarray) -> float:
    return float(np.sqrt(np.mean(a**2)) + 1e-12)


def at_dbfs(a: np.ndarray, dbfs: float) -> np.ndarray:
    return a * (10 ** (dbfs / 20) / rms(a))


def pink(n: int, rng: np.random.Generator) -> np.ndarray:
    spec = np.fft.rfft(rng.standard_normal(n))
    f = np.arange(len(spec))
    spec[1:] /= np.sqrt(f[1:])
    return np.fft.irfft(spec, n).astype(np.float32)


def brown(n: int, rng: np.random.Generator) -> np.ndarray:
    x = np.cumsum(rng.standard_normal(n)).astype(np.float32)
    return x - np.convolve(x, np.ones(1601) / 1601, mode="same")  # drop the drift


def band(a: np.ndarray, lo: float, hi: float) -> np.ndarray:
    spec = np.fft.rfft(a)
    f = np.fft.rfftfreq(len(a), 1 / SR)
    spec[(f < lo) | (f > hi)] = 0
    return np.fft.irfft(spec, len(a)).astype(np.float32)


def add_noise(speech: np.ndarray, noise: np.ndarray, snr_db: float, speech_rms: float) -> np.ndarray:
    return speech + noise * (speech_rms / rms(noise) / 10 ** (snr_db / 20))


def build(out: Path = OUT) -> dict:
    src = (Path(__file__).parent / "utterances.py").read_bytes() + Path(__file__).read_bytes()
    key = hashlib.sha1(src).hexdigest()[:10]
    manifest_path = out / "manifest.json"
    if manifest_path.exists() and json.loads(manifest_path.read_text()).get("key") == key:
        return json.loads(manifest_path.read_text())
    rng = np.random.default_rng(7)
    clean: dict[str, np.ndarray] = {}
    items = []
    for i, (uid, text) in enumerate(UTTERANCES):
        voice = VOICES[i % len(VOICES)]
        speed = float(rng.uniform(0.9, 1.15))
        parts = [p.strip() for p in text.split("|")]
        pieces = [np.zeros(int(1.5 * SR), np.float32)]
        pauses = []
        for j, part in enumerate(parts):
            pieces.append(trim(synth(part, voice, speed)))
            if j < len(parts) - 1:
                pause = float(rng.uniform(0.35, 0.9))
                pauses.append(round(pause, 2))
                pieces.append(np.zeros(int(pause * SR), np.float32))
        pieces.append(np.zeros(int(1.5 * SR), np.float32))
        clean[uid] = at_dbfs(np.concatenate(pieces), -23)
        ref = " ".join(parts)
        items.append({"id": uid, "text": ref, "voice": voice, "speed": round(speed, 2), "pauses": pauses})
        print(f"{uid:14} {voice:12} {speed:.2f} {pauses} {ref}", flush=True)

    ids = list(clean)
    for cond in CONDITIONS:
        (out / cond).mkdir(parents=True, exist_ok=True)
    for k, uid in enumerate(ids):
        a = clean[uid]
        voiced = np.abs(a) > 0.003
        speech_rms = rms(a[voiced]) if voiced.any() else rms(a)
        nrng = np.random.default_rng(100 + k)
        # babble: three other utterances, offset and summed
        bab = np.zeros_like(a)
        for m in (1, 3, 5):
            other = clean[ids[(k + m) % len(ids)]]
            other = np.roll(np.resize(other, len(a)), int(nrng.integers(0, len(a))))
            bab += other
        noisy = add_noise(a, pink(len(a), nrng), 15, speech_rms)
        noisy = add_noise(noisy, bab, 18, speech_rms)
        phone = band(a, 300, 3400)
        phone_rms = rms(phone[voiced]) if voiced.any() else rms(phone)
        phone = add_noise(phone, band(brown(len(a), nrng), 100, 3400), 20, phone_rms)
        phone = phone * (10 ** (-38 / 20) / phone_rms)
        for cond, audio in (("clean", a), ("noisy", noisy), ("phone", phone)):
            write_wav(out / cond / f"{uid}.wav", audio)
    manifest = {"key": key, "sample_rate": SR, "conditions": list(CONDITIONS), "items": items}
    manifest_path.write_text(json.dumps(manifest, indent=1))
    return manifest


def write_wav(path: Path, audio: np.ndarray, sr: int = SR) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes((np.clip(audio, -1, 1) * 32767).astype(np.int16).tobytes())


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=OUT)
    m = build(ap.parse_args().out)
    print(f"{len(m['items'])} utterances x {len(m['conditions'])} conditions")

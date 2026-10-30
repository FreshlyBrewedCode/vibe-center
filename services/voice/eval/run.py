"""Word error rate of an STT on the evaluation set, through the call pipeline's segmentation.

    ./run.sh python -m eval.run --stt http://127.0.0.1:8401 [--vocab] [--label NAME]
    ./run.sh python -m eval.run --stt cpu            # the worker's CPU fallback (faster-whisper)

Modes (each clip is one user turn; Pipecat's Silero VAD with the worker's settings runs over it
in 20 ms frames, as in a call):

- segments: the old pipeline. Pipecat's SegmentedSTTService: each VAD segment (1 s pre-roll, cut
  at every 0.2 s pause, +0.5 s silence) transcribed on its own, the texts joined
- turn: the new pipeline (turns.py): the whole turn so far at the last VAD stop
- whole: the clip as one request (the model alone, no VAD)

Writes eval/out/results/<label>.json with every hypothesis and prints WER per condition.
"""

from __future__ import annotations

import argparse
import io
import json
import time
import wave
from pathlib import Path

import httpx
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams, VADState

from voice_worker.config import CONFIG
from voice_worker.speech import _local_transcribe, vocabulary_prompt
from voice_worker.turns import TurnAudio

from .build import OUT, build
from .utterances import VOCABULARY
from .wer import edits, normalize, wer

SR = 16000
FRAME = 320 * 2  # 20 ms of 16-bit mono, the transport's frame size
TRAILING = bytes(int(0.5 * SR) * 2)  # SegmentedSTTService's trailing_silence_secs


def read_pcm(path: Path) -> bytes:
    with wave.open(str(path)) as w:
        assert w.getframerate() == SR and w.getnchannels() == 1
        return w.readframes(w.getnframes())


def wav_bytes(pcm: bytes) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm)
    return buf.getvalue()


class Stt:
    def __init__(self, target: str, vocabulary: list[str]):
        self.target = target
        self.vocabulary = vocabulary
        self.client = httpx.Client(timeout=60)
        self.server_ms: list[float] = []
        self.model = "cpu " + CONFIG.whisper_model if target == "cpu" else None

    def __call__(self, pcm: bytes) -> str:
        if self.target == "cpu":
            t = time.perf_counter()
            text = _local_transcribe(pcm, self.vocabulary)
            self.server_ms.append((time.perf_counter() - t) * 1000)
            return text
        data = {"language": "en", "response_format": "verbose_json"}
        if self.vocabulary:
            data["prompt"] = vocabulary_prompt(self.vocabulary)
        r = self.client.post(
            f"{self.target.rstrip('/')}/v1/audio/transcriptions",
            files={"file": ("a.wav", wav_bytes(pcm), "audio/wav")},
            data=data,
        )
        r.raise_for_status()
        if "x-processing-ms" in r.headers:
            self.server_ms.append(float(r.headers["x-processing-ms"]))
        body = r.json()
        self.model = body.get("model", self.model)
        return (body.get("text") or "").strip()


def vad_events(pcm: bytes) -> list[tuple[int, str]]:
    """(frame index, "start"|"stop") as Pipecat's VAD controller would report them."""
    vad = SileroVADAnalyzer(sample_rate=SR, params=VADParams(stop_secs=CONFIG.vad_stop_secs))
    vad.set_sample_rate(SR)
    events, speaking = [], False
    for i in range(0, len(pcm) - FRAME + 1, FRAME):
        state = vad._run_analyzer(pcm[i : i + FRAME])
        if state == VADState.SPEAKING and not speaking:
            speaking = True
            events.append((i // FRAME, "start"))
        elif state == VADState.QUIET and speaking:
            speaking = False
            events.append((i // FRAME, "stop"))
    if speaking:  # noise to the end of the clip: stop at its last frame
        events.append((len(pcm) // FRAME - 1, "stop"))
    return events


def old_segments(pcm: bytes, events: list[tuple[int, str]]) -> list[bytes]:
    """SegmentedSTTService's buffering (Pipecat 1.15): 1 s kept while quiet, cleared per segment."""
    at = dict(events)
    buf, speaking, segs = bytearray(), False, []
    for k, i in enumerate(range(0, len(pcm) - FRAME + 1, FRAME)):
        buf += pcm[i : i + FRAME]
        if not speaking and len(buf) > SR * 2:
            del buf[: len(buf) - SR * 2]
        ev = at.get(k)
        if ev == "start":
            speaking = True
        elif ev == "stop":
            speaking = False
            segs.append(bytes(buf) + TRAILING)
            buf.clear()
    return segs


def turn_audio(pcm: bytes, events: list[tuple[int, str]]) -> bytes:
    """turns.TurnAudio: the whole turn at its last VAD stop."""
    at = dict(events)
    turn, last = TurnAudio(SR), b""
    for k, i in enumerate(range(0, len(pcm) - FRAME + 1, FRAME)):
        turn.add(pcm[i : i + FRAME])
        ev = at.get(k)
        if ev == "start":
            turn.speech_started()
        elif ev == "stop":
            last = turn.audio() + TRAILING
    return last


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stt", default="http://127.0.0.1:8401", help="server URL or 'cpu'")
    ap.add_argument("--modes", default="segments,turn,whole")
    ap.add_argument("--conditions", default="clean,noisy,phone")
    ap.add_argument("--vocab", action="store_true", help="send eval/utterances.py's VOCABULARY")
    ap.add_argument("--label", default=None)
    a = ap.parse_args()
    manifest = build()
    modes, conds = a.modes.split(","), a.conditions.split(",")
    stt = Stt(a.stt, VOCABULARY if a.vocab else [])
    rows: dict[str, list] = {}
    for cond in conds:
        for item in manifest["items"]:
            pcm = read_pcm(OUT / cond / f"{item['id']}.wav")
            events = vad_events(pcm) if {"segments", "turn"} & set(modes) else []
            for mode in modes:
                if mode == "segments":
                    hyp = " ".join(t for t in (stt(s) for s in old_segments(pcm, events)) if t)
                elif mode == "turn":
                    audio = turn_audio(pcm, events)
                    hyp = stt(audio) if audio else ""
                else:
                    hyp = stt(pcm)
                n_err = edits(normalize(item["text"]), normalize(hyp))
                rows.setdefault(f"{mode}/{cond}", []).append(
                    {
                        "id": item["id"],
                        "ref": item["text"],
                        "hyp": hyp,
                        "errors": n_err,
                        "vad_segments": len(events) // 2,
                    }
                )
                if n_err:
                    print(f"  {mode:8} {cond:6} {item['id']:13} {n_err}  {hyp!r}", flush=True)
    label = a.label or (stt.model or a.stt).replace("/", "_").replace(" ", "_") + (
        "+vocab" if a.vocab else ""
    )
    summary = {k: round(wer([(r["ref"], r["hyp"]) for r in v]) * 100, 1) for k, v in rows.items()}
    ms = sorted(stt.server_ms)
    result = {
        "label": label,
        "stt": a.stt,
        "model": stt.model,
        "vocab": a.vocab,
        "wer": summary,
        "stt_ms_median": round(ms[len(ms) // 2], 1) if ms else None,
        "rows": rows,
    }
    (OUT / "results").mkdir(parents=True, exist_ok=True)
    (OUT / "results" / f"{label}.json").write_text(json.dumps(result, indent=1))
    print(f"\n{label}  (STT median {result['stt_ms_median']} ms per request)")
    print("mode      " + "".join(f"{c:>9}" for c in conds) + "      all")
    for mode in modes:
        allp = [(r["ref"], r["hyp"]) for c in conds for r in rows[f"{mode}/{c}"]]
        vals = "".join(f"{summary[f'{mode}/{c}']:>8.1f}%" for c in conds)
        print(f"{mode:9} {vals} {wer(allp) * 100:>7.1f}%")


if __name__ == "__main__":
    main()

"""Export the eval set as the pipelines send it to the STT, for in-process benchmarks on the GPU
box (services/speech-gpu/bench/stt_eval.py):

    ./run.sh python -m eval.export [--out eval/out/export]
    -> <cond>/<id>.turn.wav (new pipeline), <cond>/<id>.seg<k>.wav (old), manifest.json
"""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

from .build import OUT, build, write_wav
from .run import SR, old_segments, read_pcm, turn_audio, vad_events


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=OUT / "export")
    out = ap.parse_args().out
    manifest = build()
    shutil.rmtree(out, ignore_errors=True)
    items = []
    import numpy as np

    for cond in manifest["conditions"]:
        (out / cond).mkdir(parents=True)
        for item in manifest["items"]:
            pcm = read_pcm(OUT / cond / f"{item['id']}.wav")
            ev = vad_events(pcm)
            segs = old_segments(pcm, ev)
            f32 = lambda b: np.frombuffer(b, np.int16).astype(np.float32) / 32768  # noqa: E731
            write_wav(out / cond / f"{item['id']}.turn.wav", f32(turn_audio(pcm, ev)))
            write_wav(out / cond / f"{item['id']}.whole.wav", f32(pcm))
            for k, s in enumerate(segs):
                write_wav(out / cond / f"{item['id']}.seg{k}.wav", f32(s))
            items.append({**item, "cond": cond, "segments": len(segs)})
    (out / "manifest.json").write_text(json.dumps({"sample_rate": SR, "items": items}, indent=1))
    print(f"{len(items)} clips -> {out}")


if __name__ == "__main__":
    main()

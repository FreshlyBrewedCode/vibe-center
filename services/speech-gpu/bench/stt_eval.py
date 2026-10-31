"""WER/latency/VRAM of one STT model on the eval set, in-process with the server's own loaders
(stt_backend.py). The eval audio comes from services/voice: `./run.sh python -m eval.export`,
copied to /tmp/stt-eval with services/voice/eval/wer.py.

usage (on the GPU host, from ~/vibe-center/gpu-speech): VENV=<venv> ./env.sh python bench/stt_eval.py
          <model-id> <model-dir> [--fp32] [--prompt "Jeff, Ben, ..."] [--label NAME]
env: STT_EVAL_DIR (default /tmp/stt-eval), STT_PAD_SECONDS (0 = no padding), STT_TRUE_LENGTH (0 = tell the model the padded length,
     as the server did before), STT_WHISPER_BEAM, STT_WHISPER_VOCAB (hotwords|prompt)
"""
import argparse, json, os, statistics, sys, time
from dataclasses import replace
from pathlib import Path

import soundfile as sf
ROOT = Path(os.environ.get("STT_EVAL_DIR", "/tmp/stt-eval"))
sys.path[:0] = [str(Path(__file__).resolve().parent.parent), "/tmp/stt-eval"]
import stt_backend  # noqa: E402  (also routes library prints to stderr)
from catalog import BY_ID  # noqa: E402
from wer import edits, normalize, wer  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("model"); ap.add_argument("dir")
ap.add_argument("--fp32", action="store_true"); ap.add_argument("--prompt"); ap.add_argument("--label")
ap.add_argument("--modes", default="turn,segments,whole")
a = ap.parse_args()
out = stt_backend.PROTO  # stdout proper
m = BY_ID[a.model]
if a.fp32:
    m = replace(m, fp16=False)
t = time.perf_counter()
recognize = (stt_backend.load_onnx_asr if m.backend == "onnx-asr" else stt_backend.load_faster_whisper)(m, a.dir)
load_s = time.perf_counter() - t
root = ROOT
items = json.loads((root / "manifest.json").read_text())["items"]
read = lambda p: sf.read(p, dtype="float32")[0]  # noqa: E731
for _ in range(3):
    recognize(read(root / items[0]["cond"] / f"{items[0]['id']}.turn.wav"), a.prompt, None)
rows, ms = {}, []
for it in items:
    base = root / it["cond"] / it["id"]
    for mode in a.modes.split(","):
        if mode == "segments":
            parts = [recognize(read(f"{base}.seg{k}.wav"), a.prompt, None).strip() for k in range(it["segments"])]
            hyp = " ".join(p for p in parts if p)
        else:
            audio = read(f"{base}.{mode}.wav")
            t = time.perf_counter()
            hyp = recognize(audio, a.prompt, None).strip()
            if mode == "turn":
                ms.append((time.perf_counter() - t) * 1000)
        n = edits(normalize(it["text"]), normalize(hyp))
        rows.setdefault(f"{mode}/{it['cond']}", []).append({"id": it["id"], "ref": it["text"], "hyp": hyp, "errors": n})
        if n:
            print(f"  {mode:8} {it['cond']:6} {it['id']:13} {n} {hyp!r}", file=sys.stderr, flush=True)
label = a.label or a.model + ("-fp32" if a.fp32 else "")
res = {"label": label, "model": a.model, "load_s": round(load_s, 1), "vram_mb": stt_backend.vram_mib(),
       "turn_ms_median": round(statistics.median(ms), 1), "turn_ms_p90": round(sorted(ms)[int(len(ms) * 0.9)], 1),
       "env": {k: v for k, v in os.environ.items() if k.startswith("STT_")}, "prompt": a.prompt,
       "wer": {k: round(wer([(r["ref"], r["hyp"]) for r in v]) * 100, 1) for k, v in rows.items()}}
for mode in a.modes.split(","):
    res["wer"][f"{mode}/all"] = round(wer([(r["ref"], r["hyp"]) for k, v in rows.items() if k.startswith(mode + "/") for r in v]) * 100, 1)
(root / "results").mkdir(exist_ok=True)
(root / "results" / f"{label}.json").write_text(json.dumps({**res, "rows": rows}, indent=1))
out.write(json.dumps(res) + "\n")

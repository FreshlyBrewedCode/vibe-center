"""First-call cost per new input length, and the fix: pad to a fixed length bucket."""
import os, sys, time, numpy as np, onnx_asr, onnxruntime as ort, soundfile as sf

PARAKEET_DIR = os.path.expanduser("~/.cache/gpu-speech/parakeet-tdt-0.6b-v2-onnx")
from common import vram_mib
arena = os.environ.get("ARENA", "kSameAsRequested")
so = ort.SessionOptions(); so.log_severity_level = 3
cuda = ("CUDAExecutionProvider", {"arena_extend_strategy": arena, "cudnn_conv_algo_search": "HEURISTIC",
        "cudnn_conv_use_max_workspace": "0"})
m = onnx_asr.load_model("nemo-parakeet-tdt-0.6b-v2", PARAKEET_DIR, providers=[cuda], sess_options=so, quantization="fp16")
c8 = sf.read("/tmp/gpu-speech-bench/utt_8s.wav", dtype="float32")[0]
c1 = sf.read("/tmp/gpu-speech-bench/utt_1s.wav", dtype="float32")[0]
rng = np.random.default_rng(2)
lens = rng.integers(8000, len(c8), 10)
def run(pad_to, src=c8):
    ts = []
    for n in lens:
        a = src[:n] if n <= len(src) else np.pad(src, (0, n - len(src)))
        if pad_to: a = np.pad(a, (0, pad_to - len(a)))
        s = time.perf_counter(); r = m.recognize(a, sample_rate=16000); ts.append((time.perf_counter() - s) * 1000)
    return " ".join(f"{t:.0f}" for t in ts) + f"  | {r[:60]}"
print(arena, "raw            :", run(0), flush=True)
for p in (10, 16):
    run(p * 16000)  # warm the bucket
    print(arena, f"pad to {p:2d} s    :", run(p * 16000), flush=True)
print(arena, "1s clip pad 10 :", run(10 * 16000, c1), flush=True)
print("vram", vram_mib())

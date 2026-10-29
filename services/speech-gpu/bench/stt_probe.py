import os, sys, time, numpy as np, onnx_asr, onnxruntime as ort, soundfile as sf, soxr

PARAKEET_DIR = os.path.expanduser("~/.cache/gpu-speech/parakeet-tdt-0.6b-v2-onnx")
so = ort.SessionOptions(); so.log_severity_level = 3
cuda = ("CUDAExecutionProvider", {"arena_extend_strategy": "kSameAsRequested", "cudnn_conv_algo_search": "HEURISTIC",
        "cudnn_conv_use_max_workspace": "0"})
m = onnx_asr.load_model("nemo-parakeet-tdt-0.6b-v2", PARAKEET_DIR, providers=[cuda], sess_options=so, quantization="fp16")
clip = sf.read("/tmp/gpu-speech-bench/utt_3s.wav", dtype="float32")[0]
c8 = sf.read("/tmp/gpu-speech-bench/utt_8s.wav", dtype="float32")[0]
def t(name, a, n=5):
    ts = []
    for _ in range(n):
        s = time.perf_counter(); r = m.recognize(a, sample_rate=16000); ts.append((time.perf_counter() - s) * 1000)
    print(f"{name:28s} {len(a)/16000:5.2f}s  " + " ".join(f"{x:.0f}" for x in ts) + f"  | {r[:50]}", flush=True)
t("3s clip", clip)
t("8s clip", c8)
t("3s clip + 2 s zeros", np.pad(clip, (0, 32000)))
t("3s clip + 2 s noise", np.concatenate([clip, np.random.default_rng(0).standard_normal(32000).astype(np.float32) * 0.003]))
t("3s clip + 1 sample", np.pad(clip, (0, 1)))
t("3s clip - 1 sample", clip[:-1])
t("8s clip - 123 samples", c8[:-123])
t("8s clip - 1234 samples", c8[:-1234])
t("8s clip - 4321 samples", c8[:-4321])
t("8s clip again", c8)

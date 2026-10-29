"""STT candidate latency/VRAM/accuracy. usage: stt.py parakeet|parakeet-int8|whisper-turbo|whisper-distil"""
import glob, json, os, sys, time, numpy as np, soundfile as sf
from common import vram_mib, timed, UTTERANCES

which = sys.argv[1]
t = time.perf_counter()
if which.startswith("parakeet"):
    import onnx_asr
    from huggingface_hub import snapshot_download
    # a real directory: onnxruntime >= 1.31 rejects external weights behind HF-cache symlinks
    path = snapshot_download("istupakov/parakeet-tdt-0.6b-v2-onnx",
                             local_dir=os.path.expanduser("~/.cache/gpu-speech/parakeet-tdt-0.6b-v2-onnx"))
    kw = {"quantization": which.split("-", 1)[1]} if "-" in which and not which.endswith("lean") else {}
    prov = ["CUDAExecutionProvider"]
    if which.endswith("lean") or os.environ.get("LEAN"):
        # grow the arena only as needed; no huge cuDNN conv workspaces
        prov = [("CUDAExecutionProvider", {"arena_extend_strategy": "kSameAsRequested",
                 "cudnn_conv_algo_search": os.environ.get("ALGO", "HEURISTIC"), "cudnn_conv_use_max_workspace": "0"})]
    import onnxruntime as ort
    so = ort.SessionOptions(); so.log_severity_level = 3
    m = onnx_asr.load_model("nemo-parakeet-tdt-0.6b-v2", path, providers=prov, sess_options=so, **kw)
    def stt(a): return m.recognize(a, sample_rate=16000)
else:
    from faster_whisper import WhisperModel
    name = {"whisper-turbo": "large-v3-turbo", "whisper-distil": "distil-large-v3"}[which]
    m = WhisperModel(name, device="cuda", compute_type="int8_float16")
    def stt(a):
        segs, _ = m.transcribe(a, language="en", beam_size=1, vad_filter=False, without_timestamps=True,
                               condition_on_previous_text=False)
        return " ".join(s.text.strip() for s in segs)
print(f"{which}: load {time.perf_counter()-t:.1f}s", flush=True)

clips = {k: sf.read(f"/tmp/gpu-speech-bench/utt_{k}.wav", dtype="float32")[0] for k in UTTERANCES}
import soxr
for p in sorted(glob.glob("/tmp/gpu-speech-bench/human_*.wav")):
    a, sr = sf.read(p, dtype="float32")
    clips[os.path.basename(p)[6:-4]] = soxr.resample(a.mean(axis=1) if a.ndim > 1 else a, sr, 16000)
for _ in range(3): stt(clips["3s"])  # warm up
res = {"model": which}
for k, a in clips.items():
    med, mn, text = timed(lambda: stt(a))
    res[k] = dict(audio_s=round(len(a) / 16000, 2), median_ms=round(med, 1), min_ms=round(mn, 1), text=text.strip())
    print(f"  {k:>6} {len(a)/16000:5.2f}s  median {med:6.1f} ms  min {mn:6.1f} ms  | {text.strip()}", flush=True)
res["vram_mib"] = vram_mib()
print(f"  vram {res['vram_mib']} MiB", flush=True)
json.dump(res, open(f"/tmp/gpu-speech-bench/stt_{which}.json", "w"), indent=1)

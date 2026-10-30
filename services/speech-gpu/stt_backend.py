"""One STT model on the GPU, in its own process (started by the STT server, see models.py).
usage: stt_backend.py <model-id> <model-dir>

Protocol on stdin/stdout: once loaded and warmed up it prints `{"ready": true, ...}`. Then per
request it reads a JSON line `{"n": <samples>, "prompt": str|null, "language": str|null}`
followed by n float32 little-endian samples (16 kHz mono) and prints `{"text": "...", "ms": ...}`
(or `{"error": "..."}`). Logs go to stderr (the server's log).
"""
import json, logging, os, sys, time

import numpy as np

# stdout carries the protocol only: libraries that print go to stderr
PROTO = os.fdopen(os.dup(sys.stdout.fileno()), "w", buffering=1)
os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
logging.basicConfig(stream=sys.stderr, level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("stt.backend")
from catalog import BY_ID  # noqa: E402

SR = 16000
# onnxruntime's CUDA kernels keep their setup for the last input shape only: each new length
# costs ~170 ms extra. So the audio is padded with silence to a multiple of PAD seconds (one
# shape for all normal utterances), and the model is told the real length, so the padding
# doesn't skew the feature normalisation (see BENCHMARKS.md, "Padding"). 0 = no padding.
PAD = int(float(os.environ.get("STT_PAD_SECONDS", 16)) * SR)


def load_onnx_asr(m, d):
    import onnx_asr, onnxruntime as ort
    so = ort.SessionOptions(); so.log_severity_level = 3
    # grow the memory arena only as needed; heuristic cuDNN conv algorithms (no
    # per-input-length exhaustive search, no huge workspaces)
    cuda = ("CUDAExecutionProvider", {"arena_extend_strategy": "kSameAsRequested",
            "cudnn_conv_algo_search": "HEURISTIC", "cudnn_conv_use_max_workspace": "0"})
    model = onnx_asr.load_model(m.onnx_asr_name, d, providers=[cuda], sess_options=so,
                                quantization="fp16" if m.fp16 else None)
    true_length = os.environ.get("STT_TRUE_LENGTH", "1") != "0"
    # Canary (AED) is told the language, it doesn't detect it (English when not given); Parakeet
    # v3 detects it itself
    aed = "canary" in m.onnx_asr_name

    def recognize(audio, prompt, language):
        n = len(audio)
        padded = (np.pad(audio, (0, -n % PAD)) if PAD else audio)[None]
        lens = np.array([n if true_length else padded.shape[1]], dtype=np.int64)
        kw = {"language": language or "en"} if aed else {}
        return next(iter(model.asr.recognize_batch(padded, lens, **kw))).text
    return recognize


def load_faster_whisper(m, d):
    from faster_whisper import WhisperModel
    model = WhisperModel(d, device="cuda", compute_type=os.environ.get("STT_WHISPER_COMPUTE", "int8_float16"))
    beam = int(os.environ.get("STT_WHISPER_BEAM", 1))
    use = os.environ.get("STT_WHISPER_VOCAB", "hotwords")  # hotwords | prompt

    def recognize(audio, prompt, language):
        kw = {"hotwords": prompt} if use == "hotwords" else {"initial_prompt": prompt}
        segments, _ = model.transcribe(audio, language=m.whisper_language or language, beam_size=beam,
                                       condition_on_previous_text=False, without_timestamps=True,
                                       vad_filter=False, **(kw if prompt else {}))
        return " ".join(s.text.strip() for s in segments)
    return recognize


def vram_mib():
    import subprocess
    try:
        out = subprocess.run(["nvidia-smi", "--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"],
                             capture_output=True, text=True, timeout=5).stdout
        return next((int(m) for p, m in (l.split(", ") for l in out.splitlines()) if int(p) == os.getpid()), None)
    except Exception:
        return None


def main():
    mid, d = sys.argv[1], sys.argv[2]
    m = BY_ID[mid]
    t = time.perf_counter()
    try:
        recognize = (load_onnx_asr if m.backend == "onnx-asr" else load_faster_whisper)(m, d)
        # warm up on the padded shape so the first real request is not slow
        noise = (np.random.default_rng(0).standard_normal(SR * 2) * 0.01).astype(np.float32)
        for _ in range(3):
            recognize(noise, None, None)
    except Exception as e:
        log.exception("could not load %s", mid)
        PROTO.write(json.dumps({"error": f"{type(e).__name__}: {e}"}) + "\n")
        sys.exit(1)
    log.info("loaded %s in %.1fs", mid, time.perf_counter() - t)
    PROTO.write(json.dumps({"ready": True, "model": mid, "load_s": round(time.perf_counter() - t, 1),
                            "vram_mb": vram_mib()}) + "\n")
    stdin = sys.stdin.buffer
    while True:
        head = stdin.readline()
        if not head:
            return
        req = json.loads(head)
        audio = np.frombuffer(stdin.read(req["n"] * 4), dtype="<f4")
        t = time.perf_counter()
        try:
            text = recognize(audio, req.get("prompt"), req.get("language")).strip()
            PROTO.write(json.dumps({"text": text, "ms": round((time.perf_counter() - t) * 1000, 1)}) + "\n")
        except Exception as e:
            log.exception("transcription failed")
            PROTO.write(json.dumps({"error": f"{type(e).__name__}: {e}"}) + "\n")


if __name__ == "__main__":
    main()

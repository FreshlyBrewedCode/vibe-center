"""Kokoro-82M (official `kokoro` package, torch CUDA): TTFA, RTF, VRAM; writes STT test clips."""
import json, sys, time, numpy as np, soundfile as sf, soxr, torch
from kokoro import KPipeline
from common import vram_mib, UTTERANCES

VOICE = sys.argv[1] if len(sys.argv) > 1 else "af_heart"
SHORT = "Sure, I will check the build and get back to you."   # ~10 words
MEDIUM = ("I looked at the failing test in the payments service. The mock returns an empty list, "
          "so the retry loop never ends. I can patch it and open a pull request, if you like.")  # ~33 words

t = time.perf_counter()
pipe = KPipeline(lang_code="a", repo_id="hexgrad/Kokoro-82M", device="cuda")
pipe.load_voice(VOICE)
print(f"load {time.perf_counter()-t:.1f}s", flush=True)

def synth(text, split=r"(?<=[.!?])\s+"):
    t0 = time.perf_counter(); ttfa = None; chunks = []
    for r in pipe(text, voice=VOICE, speed=1.0, split_pattern=split):
        a = r.audio.cpu().numpy()
        if ttfa is None: ttfa = time.perf_counter() - t0
        chunks.append(a)
    total = time.perf_counter() - t0
    audio = np.concatenate(chunks)
    return ttfa * 1000, total * 1000, audio

for _ in range(3): synth(MEDIUM)  # warm up
res = {}
for name, text in [("short", SHORT), ("medium", MEDIUM)]:
    runs = [synth(text) for _ in range(5)]
    ttfa = sorted(r[0] for r in runs)[2]; total = sorted(r[1] for r in runs)[2]
    dur = len(runs[0][2]) / 24000
    res[name] = dict(words=len(text.split()), ttfa_ms=round(ttfa), total_ms=round(total), audio_s=round(dur, 2), rtf=round(total / 1000 / dur, 3))
    print(name, res[name], flush=True)
    sf.write(f"/tmp/gpu-speech-bench/tts_{name}_{VOICE}.wav", runs[0][2], 24000)
res["vram_mib"] = vram_mib(); res["torch_peak_mib"] = round(torch.cuda.max_memory_allocated() / 2**20)
print("vram", res["vram_mib"], "torch peak", res["torch_peak_mib"], flush=True)

# STT test clips at 16 kHz mono s16le
for k, text in UTTERANCES.items():
    _, _, a = synth(text)
    a16 = soxr.resample(a, 24000, 16000)
    sf.write(f"/tmp/gpu-speech-bench/utt_{k}.wav", a16, 16000, subtype="PCM_16")
    print(k, f"{len(a16)/16000:.2f}s", flush=True)
json.dump(res, open(f"/tmp/gpu-speech-bench/tts_kokoro_{VOICE}.json", "w"), indent=1)

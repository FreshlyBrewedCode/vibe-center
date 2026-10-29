"""Where does Kokoro's per-chunk time go: G2P (misaki/spaCy, CPU) vs the model (GPU)?"""
import time, statistics, torch
from kokoro import KPipeline
pipe = KPipeline(lang_code="a", repo_id="hexgrad/Kokoro-82M", device="cuda")
pack = pipe.load_voice("af_heart")
for text in ["Okay.", "Sure, I will check the build and get back to you."]:
    g, mdl = [], []
    for i in range(8):
        t = time.perf_counter(); _, tokens = pipe.g2p(text); ps = "".join(t.phonemes + (" " if t.whitespace else "") for t in tokens if t.phonemes).strip()
        g.append((time.perf_counter() - t) * 1000)
        t = time.perf_counter(); out = KPipeline.infer(pipe.model, ps, pack, 1.0); out.audio.cpu(); mdl.append((time.perf_counter() - t) * 1000)
    print(f"{text!r}: g2p {statistics.median(g[2:]):.0f} ms, model {statistics.median(mdl[2:]):.0f} ms", flush=True)

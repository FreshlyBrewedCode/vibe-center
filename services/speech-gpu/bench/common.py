import os, statistics, subprocess, time

def vram_mib(pid=None):
    """GPU memory the driver attributes to this process (incl. CUDA context)."""
    pid = pid or os.getpid()
    out = subprocess.run(["nvidia-smi", "--query-compute-apps=pid,used_memory",
                          "--format=csv,noheader,nounits"], capture_output=True, text=True).stdout
    for line in out.splitlines():
        p, m = [x.strip() for x in line.split(",")]
        if int(p) == pid:
            return int(m)
    return None

def timed(fn, n=7):
    ts = []
    for _ in range(n):
        t = time.perf_counter(); r = fn(); ts.append((time.perf_counter() - t) * 1000)
    return statistics.median(ts), min(ts), r

# reference utterances (~1 s, ~3 s, ~8 s) with some coding vocabulary
UTTERANCES = {
    "1s": "Yes, merge it.",
    "3s": "Open a pull request for the vibe center repo.",
    "8s": "Check the CI status on PR forty two, and if the tests pass, ask the agent to rebase the branch and run the CLI smoke test again.",
}

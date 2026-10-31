"""Download one catalog model into its directory (run by the STT server as a subprocess, so a
download can be cancelled by killing it). usage: python fetch.py <model-id> <dir>

Prints `total <bytes>` once the size is known, then `phase convert` if the model gets the fp16
encoder (Parakeet: the fp32 weights are deleted afterwards, they aren't served). The server
writes the `.complete` marker when this exits 0.
"""
import fnmatch, os, subprocess, sys

# plain HTTP: on the GPU host's line Xet fetched ~1.3 MB/s against ~6.4 MB/s, and it writes the file
# only at the end, so the progress bar (the directory's size) would stand still
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
from huggingface_hub import HfApi, snapshot_download  # noqa: E402
from catalog import BY_ID

model = BY_ID[sys.argv[1]]
d = sys.argv[2]
os.makedirs(d, exist_ok=True)
try:
    info = HfApi().model_info(model.repo, files_metadata=True)
    total = sum(s.size or 0 for s in info.siblings
                if any(fnmatch.fnmatch(s.rfilename, p) for p in model.files))
    print(f"total {total}", flush=True)
except Exception as e:  # progress is a nicety; the download itself decides
    print(f"no size ({e!r})", file=sys.stderr, flush=True)
# a real directory, not the HF cache: onnxruntime >= 1.31 refuses external weights behind its symlinks
snapshot_download(model.repo, local_dir=d, allow_patterns=list(model.files))
if model.fp16 and not os.path.exists(os.path.join(d, "encoder-model.fp16.onnx.data")):
    print("phase convert", flush=True)
    here = os.path.dirname(os.path.abspath(__file__))
    subprocess.run([sys.executable, os.path.join(here, "parakeet_fp16.py"), d], check=True)
if model.fp16:  # only the fp16 files are served
    for f in ("encoder-model.onnx", "encoder-model.onnx.data", "decoder_joint-model.onnx", "decoder-model.onnx"):
        if os.path.exists(os.path.join(d, f)):
            os.remove(os.path.join(d, f))
print("done", flush=True)

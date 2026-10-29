"""Fetch the models into the caches (idempotent; quick when already there).
Parakeet-TDT 0.6B v2 (ONNX export by istupakov) into a real directory, plus our fp16 encoder;
Kokoro-82M into the Hugging Face cache."""
import os, subprocess, sys
from huggingface_hub import snapshot_download
from common import PARAKEET_DIR

# a real directory, not the HF cache: onnxruntime >= 1.31 refuses external weights behind its symlinks
snapshot_download("istupakov/parakeet-tdt-0.6b-v2-onnx", local_dir=PARAKEET_DIR,
                  allow_patterns=["config.json", "vocab.txt", "nemo128.onnx", "encoder-model.onnx*",
                                  "decoder_joint-model.onnx"])
if not os.path.exists(os.path.join(PARAKEET_DIR, "encoder-model.fp16.onnx.data")):
    print("converting the Parakeet encoder to fp16 (~30 s)", flush=True)
    subprocess.run([sys.executable, os.path.join(os.path.dirname(__file__), "parakeet_fp16.py"), PARAKEET_DIR], check=True)
snapshot_download("hexgrad/Kokoro-82M", allow_patterns=["config.json", "kokoro-v1_0.pth", "voices/*"])
print("models ready", flush=True)

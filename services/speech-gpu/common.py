"""Shared bits of the two servers."""
import logging, os, sys

PARAKEET_DIR = os.path.expanduser("~/.cache/gpu-speech/parakeet-tdt-0.6b-v2-onnx")

logging.basicConfig(stream=sys.stdout, level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(name)s: %(message)s")
for noisy in ("httpx", "huggingface_hub", "filelock"):
    logging.getLogger(noisy).setLevel(logging.WARNING)

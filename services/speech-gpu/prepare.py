"""Fetch what the servers need before they start (idempotent; quick when already there):
the default STT model (catalog.py) into ~/.cache/gpu-speech/models, unless some catalog model is
already there, and Kokoro-82M into the Hugging Face cache. Every other STT model is downloaded
only when someone selects it (the STT server's /v1/stt/models API, Settings -> Voice)."""
import subprocess, sys, time
from huggingface_hub import snapshot_download
import common  # noqa: F401  (logging setup)
from catalog import DEFAULT_MODEL
from models import DEFAULT_COMMANDS, ModelManager
from stt_server import MODELS_DIR

mm = ModelManager(MODELS_DIR)
mm.migrate_legacy()  # a Parakeet from before the catalog
if not any(mm.downloaded(m.id) for m in mm.catalog):
    print(f"downloading the default STT model {DEFAULT_MODEL}", flush=True)
    m = mm.model(DEFAULT_MODEL)
    subprocess.run(DEFAULT_COMMANDS.fetch(m, mm.dir(m.id)), check=True)
    (mm.dir(m.id) / ".complete").write_text(time.strftime("%Y-%m-%d %H:%M:%S"))
snapshot_download("hexgrad/Kokoro-82M", allow_patterns=["config.json", "kokoro-v1_0.pth", "voices/*"])
print("models ready", flush=True)

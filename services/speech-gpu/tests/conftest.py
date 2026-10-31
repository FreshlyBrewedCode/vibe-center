import sys
from pathlib import Path

# the server's modules are top-level scripts (run from services/speech-gpu on the GPU host)
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

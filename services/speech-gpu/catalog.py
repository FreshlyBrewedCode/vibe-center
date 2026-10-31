"""The STT models the server can download and serve (see BENCHMARKS.md for the numbers).

Each entry says where its files come from, which runtime runs it (`cu13`: the server's own .venv,
onnxruntime CUDA 13; `cu12`: .venv-whisper, ctranslate2 needs CUDA 12 and is installed with the
first model that needs it), and what to show in a model picker. `latency_ms`, `vram_mb` and
`wer` were measured on the GPU host's RTX 3070 (BENCHMARKS.md, "STT model catalog"); `wer` is the
evaluation set of services/voice/eval through the call pipeline, all conditions.
"""
from dataclasses import dataclass, field

DEFAULT_MODEL = "parakeet-tdt-0.6b-v2"


@dataclass(frozen=True)
class Model:
    id: str
    name: str
    backend: str  # "onnx-asr" | "faster-whisper"
    runtime: str  # "cu13" | "cu12"
    repo: str  # Hugging Face repo
    files: tuple[str, ...]  # allow_patterns for the download
    download_mb: int  # what the download fetches
    languages: list[str]
    accuracy: str  # a short note for the picker
    supports_vocabulary: bool
    latency_ms: int  # median server time per utterance as served
    vram_mb: int  # the backend process, CUDA context included
    wer: float | None  # % on our eval set (turn mode, clean+noisy+phone)
    recommended: bool = False
    onnx_asr_name: str = ""  # onnx-asr model type
    fp16: bool = False  # convert the encoder to fp16 after download (parakeet_fp16.py)
    whisper_language: str | None = None  # fixed language for an English-only Whisper
    extra: dict = field(default_factory=dict)


PARAKEET_FILES = ("config.json", "vocab.txt", "nemo128.onnx", "encoder-model.onnx*", "decoder_joint-model.onnx")

CATALOG: list[Model] = [
    Model(
        id="parakeet-tdt-0.6b-v2",
        name="Parakeet TDT 0.6B v2",
        backend="onnx-asr",
        runtime="cu13",
        repo="istupakov/parakeet-tdt-0.6b-v2-onnx",
        files=PARAKEET_FILES,
        download_mb=2470,
        languages=["en"],
        accuracy="The most accurate and the fastest here, in English. Writes numbers as digits.",
        supports_vocabulary=False,
        latency_ms=50,
        vram_mb=1700,
        wer=3.0,
        recommended=True,
        onnx_asr_name="nemo-parakeet-tdt-0.6b-v2",
        fp16=True,
    ),
    Model(
        id="parakeet-tdt-0.6b-v3",
        name="Parakeet TDT 0.6B v3",
        backend="onnx-asr",
        runtime="cu13",
        repo="istupakov/parakeet-tdt-0.6b-v3-onnx",
        files=PARAKEET_FILES,
        download_mb=2490,
        languages=["en", "de", "fr", "es", "it", "nl", "pl", "pt", "sv", "da", "fi", "cs", "+13"],
        accuracy="Parakeet for 25 European languages, detected per utterance. Fast, but transcribes background talk.",
        supports_vocabulary=False,
        latency_ms=55,
        vram_mb=1730,
        wer=12.3,
        onnx_asr_name="nemo-parakeet-tdt-0.6b-v3",
        fp16=True,
    ),
    Model(
        id="whisper-large-v3-turbo",
        name="Whisper large-v3 turbo",
        backend="faster-whisper",
        runtime="cu12",
        repo="dropbox-dash/faster-whisper-large-v3-turbo",
        files=("config.json", "model.bin", "tokenizer.json", "vocabulary.json", "preprocessor_config.json"),
        download_mb=1620,
        languages=["multilingual (99)"],
        accuracy="Multilingual and the only one that uses your custom vocabulary (2.9 % WER with it). ~4x slower.",
        supports_vocabulary=True,
        latency_ms=185,
        vram_mb=1230,
        wer=3.6,
    ),
    Model(
        id="canary-1b-v2",
        name="Canary 1B v2",
        backend="onnx-asr",
        runtime="cu13",
        repo="istupakov/canary-1b-v2-onnx",
        files=("config.json", "vocab.txt", "encoder-model.onnx*", "decoder-model.onnx"),
        download_mb=3780,
        languages=["en", "de", "fr", "es", "+21"],
        accuracy="NVIDIA's larger multilingual model (25 languages), robust in noise. Needs the language set.",
        supports_vocabulary=False,
        latency_ms=95,
        vram_mb=3160,
        wer=3.7,
        onnx_asr_name="nemo-canary-1b-v2",
        fp16=True,
    ),
]

BY_ID = {m.id: m for m in CATALOG}

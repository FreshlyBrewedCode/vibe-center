I have enough material now to compile the structured findings.

## Non-Whisper Local STT Research Findings

### NVIDIA Parakeet TDT (0.6B v2 / v3)
- **Params/size**: 600M params ("0.6B"); disk size not explicitly published on either model card. [v2 card](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2) [v3 card](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3)
- **Memory**: "At least 2GB RAM to load" per NVIDIA's own card (applies to loading on GPU with NeMo); larger RAM needed for longer audio with full-attention. [v2/v3 cards](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3)
- **Architecture/paradigm**: FastConformer encoder + TDT decoder, trained for batch/full-attention transcription up to 24 min (A100 80GB); v3 README also references a streaming inference script with configurable chunk size/context, i.e. chunked streaming is possible but not the default mode. [v3 card](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3)
- **RTFx (Open ASR Leaderboard, batch=128, GPU unspecified but leaderboard uses A100/similar)**: v2 = 3386; v3 = 3333. [NVIDIA dev blog](https://developer.nvidia.com/blog/nvidia-speech-ai-models-deliver-industry-leading-accuracy-and-performance/), [v3 card](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3)
- **RTX 3070/consumer GPU**: No official NVIDIA number found. Secondary source claims "Parakeet TDT on CPU (i7-12700KF) outperforms faster-whisper on RTX 3070 Ti by 2.25x" and that v3 is "in the same range or faster" on RTX 3060/4060 — both unofficial, mark as unconfirmed. [localaimaster](https://localaimaster.com/models/parakeet-tdt)
- **WER**: v2 average 6.05% (Open ASR Leaderboard, English-only), range 1.69% (LibriSpeech test-clean) to 11.16% (AMI). v3 average 6.34% (1.93% LS test-clean, 3.59% LS test-other); multilingual Fleurs average 11.97%, German specifically 5.04% (Fleurs) / 4.84% (CoVoST). [v2 card](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2), [v3 card](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3)
- **Languages**: v2 = English only. v3 = 25 European languages including German, auto-detected. [v3 card](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3)
- **License**: CC-BY-4.0, commercial use allowed. [v2 card](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2)
- **Maintenance**: v2 released May 1 2025; v3 released Aug 14 2025 ([NVIDIA dev blog](https://developer.nvidia.com/blog/nvidia-speech-ai-models-deliver-industry-leading-accuracy-and-performance/)); NeMo/NVIDIA actively iterating (v3, Canary-1B-v2 shipped together per arXiv paper). [arXiv 2509.14128](https://arxiv.org/html/2509.14128v2)
- **Hotwords/custom vocab**: Not natively documented on the NVIDIA card itself; achieved via sherpa-onnx port (see below) using `modified_beam_search` + Aho-Corasick hotword biasing, not via NeMo/HF pipeline directly.

### NVIDIA Canary (1B-v2, 1B, 180M-Flash, Qwen-2.5B)
- **Canary-1B-v2**: 978M params, 32 encoder/8 decoder layers. License CC-BY-4.0. Needs "at least 6GB RAM to load." Languages: 25 European incl. German. WER: Open ASR Leaderboard mean 7.15%, RTFx 749; Fleurs-25 8.40%, CoVoST-13 8.85%, MLS-6 7.27%. Released 08/14/2025. [HF card](https://huggingface.co/nvidia/canary-1b-v2)
- **Canary-180M-Flash**: 182M params, >1200 RTFx, supports 4 languages (ASR+translation). [arXiv 2509.14128](https://arxiv.org/html/2509.14128v2)
- **Canary-Qwen-2.5B**: exists as an LLM-backed ASR variant; no benchmark detail fetched (not deeply researched — gap).
- **Streaming**: Not documented as a streaming/chunked-partial model; appears batch/offline-oriented like Whisper-style encoder-decoder (lower RTFx than Parakeet TDT, consistent with non-streaming full-attention architecture).
- **Maintenance**: Actively released alongside Parakeet v3 in Aug 2025 per NVIDIA/arXiv paper.

### parakeet-mlx (Apple Silicon port)
- **What it is**: Community MLX port(s) of Parakeet for Apple Silicon; the most referenced/maintained fork appears to be `senstella/parakeet-mlx`, with other forks (EliFuzz, timothybrush, acgourley) offering similar or extended features (streaming, noise reduction, silence detection). [GitHub listing](https://github.com/senstella/parakeet-mlx)
- **RTF / latency on Apple Silicon** (third-party benchmarks, not official):
  - M3 Pro: Parakeet v2 ~110-111ms p50 latency, 7.1% WER; v3 ~115-125ms p50, 8.2% WER. [source via search aggregation, unconfirmed primary]
  - M3 Max 64GB: Parakeet TDT 0.6B v3 RTFx 59x (5s audio) to 103x (60s audio).
  - M2 GPU: parakeet-mlx package reported ~37x realtime in one report.
  - M4: one HF model card (NeurologyAI/neuro-parakeet-mlx) reports RTF 0.042 (~24x realtime).
  - **No official/first-party M1 8GB or 16GB benchmark found** — this is a gap; M1 numbers would need to be interpolated/estimated from M2/M3 scaling, which is speculative and should be flagged as such in the report.
- **Memory**: Not explicitly reported for MLX port; base model is 600M params (~2.4GB fp32 / ~1.2GB fp16), should fit comfortably in 8GB unified memory but no direct measurement found.
- **Streaming**: True partial-transcript streaming supported per repo description (chunking + streaming claimed). [EliFuzz/senstella repo descriptions](https://github.com/EliFuzz/parakeet-mlx)
- **License/maintenance**: Community project (not NVIDIA-official), license varies by fork — need to check individual repos (not confirmed here, gap). Active forks exist as of searches referencing "Workflow runs" and recent commits (2026).
- **Languages**: Inherits whatever underlying Parakeet checkpoint is loaded (v2=English only, v3=multilingual incl. German) — confirm per-fork which checkpoint is bundled.

### ONNX ports of Parakeet/Canary (sherpa-onnx, onnx-asr/istupakov)
- **sherpa-onnx (k2-fsa)**: Supports NeMo Parakeet TDT (v2, v3) and Canary models via C++/Python/Go/C#/Dart APIs, shipped as INT8-quantized ONNX (e.g. `sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8` supporting 25 languages). [GitHub](https://github.com/k2-fsa/sherpa-onnx), [search aggregation]
  - **Hotwords/contextual biasing**: Explicit, documented feature — Aho-Corasick-based hotword/contextual biasing; requires `modified_beam_search` decoding (not supported with default `greedy_search`); only transducer models support it. PR #3895 added hotword support specifically for streaming NeMo transducer models (i.e. Parakeet-family). [sherpa docs](https://k2-fsa.github.io/sherpa/onnx/hotwords/index.html), [PR #3895](https://github.com/k2-fsa/sherpa-onnx/pull/3895)
  - **Maintenance**: Very active — latest release v2.0.1 on Oct 26 2026 (3 days before this research), multiple releases/month through 2025-2026, Intel NPU/OpenVINO support added Sept 2026. License Apache 2.0. [Releases](https://github.com/k2-fsa/sherpa-onnx/releases)
  - **Also supports streaming Zipformer models** (see below) and German is present at least via NeMo FastConformer CTC multilingual model `sherpa-onnx-nemo-fast-conformer-ctc-be-de-en-es-fr-hr-it-pl-ru-uk-20k` (be/de/en/es/fr/hr/it/pl/ru/uk). No standalone German-only streaming Zipformer model found in search — likely covered only via multilingual NeMo/Parakeet v3 ports rather than a dedicated Zipformer-de release. **Gap**: did not find a dedicated k2-fsa streaming Zipformer German-only checkpoint; the multilingual FastConformer CTC model is the closest confirmed German-capable streaming option.
- **onnx-asr (istupakov)**: Lightweight pure-Python ONNX runner (no PyTorch/Transformers/FFmpeg dependency); supports Parakeet v2 (EN)/v3 (multilingual), Canary v1/v2 (multilingual), GigaAM v2/v3 (Russian) and GigaAM Multilingual. Runs on CUDA, TensorRT, CoreML, DirectML, ROCm, WebGPU — i.e., covers both target platforms (RTX via CUDA/TensorRT, Apple Silicon via CoreML). [GitHub](https://github.com/istupakov/onnx-asr), [HF: istupakov/parakeet-tdt-0.6b-v3-onnx](https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx)
  - No specific WER/RTF numbers independently published by istupakov beyond inheriting the underlying NeMo model's accuracy (ONNX export should be numerically close to original); not separately benchmarked in sources found — gap.

### Kyutai STT (Delayed Streams Modeling)
- **Models**: `kyutai/stt-1b-en_fr` (1B params, bilingual EN/FR, ~500ms delay) and `kyutai/stt-2.6b-en` (2.6B params, English-only, ~2.5s delay, more accurate). [Kyutai STT page](https://kyutai.org/stt/)
- **Streaming paradigm**: True native streaming — "delayed streams modeling" aligns audio and text as parallel, time-synchronous streams, so no separate VAD/chunking glue code is needed; this is architecturally different from VAD-segmented batch transcription. [Kyutai STT page](https://kyutai.org/stt/)
- **Latency**: Fixed algorithmic delay before output starts: 500ms (1B model) or 2.5s (2.6B model); a "flush trick" can reduce end-of-utterance latency by exploiting ~4x real-time decode speed. [Kyutai STT page](https://kyutai.org/stt/)
- **Throughput/hardware**: H100 can serve ~400 concurrent real-time streams; L40S can serve 64 concurrent connections at 3x real-time factor. No RTX 3070 or M1 numbers found — gap. [Kyutai STT page](https://kyutai.org/stt/)
- **WER**: `stt-2.6b-en` scores 6.40% average WER on Open ASR Leaderboard (ranked 9th) vs. Whisper large-v3's 7.44% (ranked 25th); on LibriSpeech specifically, Kyutai 2.6B scores 6.64% vs Whisper large-v3's 6.43% (Whisper slightly better on this one subset). [search aggregation citing Open ASR Leaderboard]
- **Languages**: 1B model = English + French; 2.6B model = English only. **No German support found** — this is a gap/limitation for the stated requirement.
- **License**: Code is MIT (Python) / Apache (Rust backend) / MIT (web client); model weights CC-BY-4.0. [GitHub](https://github.com/kyutai-labs/delayed-streams-modeling)
- **Maintenance**: Active Kyutai Labs project, paper published 2025 (arXiv 2509.08753), current as of research date.

### Moonshine (Useful Sensors / Moonshine AI)
- **Model sizes**: Tiny = 27M params, 35MB (Q8_0 quantized); Base = 62M params, 77MB (Q8_0). [search aggregation, arXiv 2509.02523 "Flavors of Moonshine"]
- **WER (LibriSpeech test-clean)**: Tiny 4.60%, Base 3.26% — on par with or better than Whisper tiny.en/base.en respectively. [search aggregation]
- **Streaming**: Explicitly designed for live streaming with low latency, doing work incrementally while user is still talking (true streaming, not VAD-chunked). [GitHub](https://github.com/usefulsensors/moonshine)
- **Platforms**: Python, JS/WASM, iOS, Android, macOS, Linux, Windows, Raspberry Pi — covers both target platforms (M1 Mac and PC).
- **License**: MIT for English models at every size; Moonshine Community License (non-commercial) for "legacy non-streaming" non-English models — **this directly affects German support**: if a German Moonshine model exists, it may fall under the non-commercial legacy license rather than MIT. Did not confirm whether a German Moonshine model currently exists at all — gap, needs explicit check of moonshine-voice.readthedocs.io model list.
- **Maintenance**: Org rebranded from "Useful Sensors" to "Moonshine AI" (github.com/moonshine-ai); 666+ commits, recent activity confirmed via GitHub Actions workflow runs. Active as of research.
- **Hardware**: RAM/VRAM not explicitly quantified per model in sources found — gap (model sizes under 100MB in Q8_0 form imply minimal memory footprint, likely well under 1GB RAM, but not an official figure).

### Vosk
- **Model sizes/WER** (from alphacephei.com/vosk/models):
  - English small (`vosk-model-small-en-us-0.15`): 40MB, WER 9.85% (LibriSpeech)
  - English large (`vosk-model-en-us-0.22`): 1.8GB, WER 5.69%
  - English large (`vosk-model-en-us-0.42-gigaspeech`): 2.3GB, WER 5.64%
  - German small (`vosk-model-small-de-0.15`): 45MB, WER 13.75%
  - German large (`vosk-model-de-0.21`): 1.9GB, WER 9.83%
  - German large (`vosk-model-de-tuda-0.6-900k`): 4.4GB, WER 9.48%
  [alphacephei.com/vosk/models](https://alphacephei.com/vosk/models)
- **Memory**: Small models ~300MB runtime RAM; big models can require "up to 16GB" RAM. [alphacephei.com/vosk/models]
- **Paradigm**: Kaldi-based, true streaming (chunked online decoding), not pure VAD-batch.
- **Custom vocabulary/hotwords**: Strong, explicit support — "grammar mode" restricts the WFST decoding graph to a specified word list (JSON array), improving both speed and accuracy by narrowing the search space; separate from LM-based free recognition. Useful for CLI-command/repo-name vocab constraining. Caveat: omitting `[unk]` from the grammar list causes the decoder to get stuck on out-of-grammar audio. [vosk-api issue #319](https://github.com/alphacep/vosk-api/issues/319), [deepwiki customization](https://deepwiki.com/alphacep/vosk-api/6.3-customization)
- **License**: Apache 2.0, all models. [alphacephei.com/vosk/models]
- **Maintenance**: Mixed signal — last commit Aug 9 2026 (typo fix only), no new PyPI release in 12+ months, 547 open issues, only 1 active maintainer; third-party tracker (Snyk) rates it "Inactive." Effectively low-maintenance/stagnant as of Oct 2026 despite not being formally abandoned. [GitHub commits](https://github.com/alphacep/vosk-api/commits/master/), [Snyk advisor](https://snyk.io/advisor/python/vosk)

### sherpa-onnx streaming Zipformer models (k2-fsa)
- Covered partly above under ONNX ports section. Additional notes:
- Zipformer-transducer streaming models exist for many languages (Chinese, English, bilingual zh-en, Indonesian, Korean, etc.) per k2-fsa docs. [Zipformer transducer models doc](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/online-transducer/zipformer-transducer-models.html)
- **No confirmed dedicated German-only streaming Zipformer checkpoint** was found; German coverage instead comes through multilingual NeMo FastConformer/Parakeet v3 ONNX ports within the sherpa-onnx ecosystem. This is a gap worth flagging explicitly in the report.
- Hotwords (Aho-Corasick, `modified_beam_search`) apply to Zipformer transducer models as well as NeMo transducer models — same mechanism as described above.
- Framework overall is Apache 2.0, extremely actively maintained (releases days before this research).

### Voxtral (Mistral AI)
- **Variants**: Voxtral Small (24B, enterprise-scale) and Voxtral Mini (3B, edge/local use); a specific "Voxtral Realtime" variant uses a causal audio encoder for true left-to-right streaming, distinct from "Voxtral Mini Transcribe V2" which is batch/offline. [DataCamp](https://www.datacamp.com/tutorial/voxtral-mistral), [dev.to](https://dev.to/mcrolly/mistral-voxtral-tts-what-open-source-on-device-voice-ai-means-for-local-human-ai-interaction-and-omf)
- **Local/offline use**: Explicitly supported — can run fully offline, no audio leaves device; pairs with vLLM for throughput. Third-party Rust/Burn implementation exists (`voxtral-mini-realtime-rs`), and a Wyoming-protocol integration exists for Home Assistant.
- **License**: Apache 2.0 (open weights). [search aggregation]
- **Context window**: 32K tokens, up to 30 min audio for transcription / 40 min for understanding tasks.
- **Caveat for this use case**: Voxtral is LLM-based (not a lightweight dedicated ASR model), so its RAM/VRAM footprint is almost certainly far larger than Parakeet/Moonshine/Vosk even at "Mini" (3-4B) size — likely too heavy for an 8GB M1 or comfortably loaded alongside other components on an 8GB RTX 3070, though no concrete VRAM figure was found in this research (gap). No WER/RTF numbers specific to Voxtral Mini were retrieved — gap, would need to check the Voxtral model card/leaderboard directly.

---

### Gaps (explicitly unconfirmed / not found)
- No official NVIDIA RTF/RTFx benchmark specifically on RTX 3070 (8GB) for Parakeet or Canary — only third-party/unofficial claims about RTX 3060/4060/3070 Ti.
- No official or reliable M1 (8GB or 16GB specifically) benchmarks for parakeet-mlx — only M2/M3/M4 data found; M1 numbers would require extrapolation and were not independently verified.
- parakeet-mlx fork licensing not individually confirmed (multiple forks: senstella, EliFuzz, timothybrush, acgourley) — need per-repo check.
- No dedicated German-only sherpa-onnx streaming Zipformer checkpoint confirmed; German is covered only via multilingual NeMo/Parakeet v3 ONNX ports.
- Moonshine: existence and licensing status of any German-language model not confirmed (only a `moonshine-tiny-fr` French community model was surfaced); Moonshine RAM/VRAM figures not found.
- Kyutai STT has no German-language model — English/French only (1B) or English only (2.6B) — and no RTX 3070/M1-specific latency/RTF numbers were found, only H100/L40S throughput figures.
- Voxtral: no WER/RTF benchmarks or concrete VRAM/RAM figures retrieved for Voxtral Mini/Realtime; its LLM-based nature likely means higher resource use than other candidates here, but this is inference, not a sourced number.
- onnx-asr (istupakov) has no independently published WER/RTF numbers distinct from the underlying NeMo models' own reported accuracy.
- Canary-Qwen-2.5B was identified but not researched in depth (params, WER, use case) — flagged but not covered.
- Disk size in MB/GB for Parakeet TDT and Canary models (fp32/fp16 download size) was not explicitly stated on either HF model card despite being requested — only parameter counts were available.
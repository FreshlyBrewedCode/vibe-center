I have enough primary-sourced material now. Compiling the final report.

## Whisper-family Local STT Research (for real-time voice agent)

### 1. faster-whisper (CTranslate2)

- **Model sizes**: tiny/base/small/medium/large-v2/large-v3, plus turbo backend and distil-whisper checkpoints (e.g. `distil-large-v3`) explicitly supported. [GitHub](https://github.com/SYSTRAN/faster-whisper)
- **Disk size**: not stated directly in README; same underlying CT2-converted weights as OpenAI Whisper (large-v3 ≈1.5GB fp16 / ~0.8GB int8). Not found as an explicit table in the README.
- **VRAM usage**: large-v2, fp16, beam=5: **4755MB** GPU / 3244MB CPU RAM; int8: **3091MB** GPU / 3117MB CPU RAM. Small model CPU-only fp32: 1675MB RAM; int8: 995MB RAM. [GitHub README benchmark table](https://github.com/SYSTRAN/faster-whisper)
- **Latency/paradigm**: batch/VAD-chunk paradigm, not native token-streaming. Large-v2 on **RTX 3070 Ti** (fp16): 1m03s for a 13-min clip (vs 2m23s for openai/whisper); on i7-12700K CPU, small model fp32: 2m37s (vs 6m58s baseline). [GitHub](https://github.com/SYSTRAN/faster-whisper)
- **RTF**: derivable as ~12-13x real-time on RTX 3070 Ti for large-v2 fp16 (13min/1m03s ≈ 12.4x). This is the closest primary-source number to the target RTX 3070 (3070 Ti, noted as substitution).
- **Accuracy**: shares weights with OpenAI Whisper, so WER should match upstream Whisper numbers (see Open ASR Leaderboard figures under large-v3/turbo below) — no faster-whisper-specific WER regression claimed; "up to 4x faster... for the same accuracy." [GitHub](https://github.com/SYSTRAN/faster-whisper)
- **Streaming**: faster-whisper itself is batch/offline; true streaming is bolted on by third-party wrappers (WhisperLive, whisper-streaming) built on top of it. [GitHub](https://github.com/SYSTRAN/faster-whisper)
- **Language**: multilingual (same as Whisper, 99 languages incl. German), automatic language detection with probability scores. [GitHub](https://github.com/SYSTRAN/faster-whisper)
- **License**: MIT. [GitHub](https://github.com/SYSTRAN/faster-whisper)
- **Maintenance**: actively maintained — repo pushed 2026-10-25, 26,291 stars, only 19 open issues (low velocity relative to size), per GitHub API as of 2026-10-29.
- **Custom vocabulary**: supports both `initial_prompt` (only biases the first 30s window when `condition_on_previous_text=False`) and `hotwords` (added in v1.0.2, re-applied every window — generally preferred for proper nouns/technical terms over long initial_prompt lists, which can degrade quality beyond ~200 tokens). [theneuralbase.com](https://theneuralbase.com/faster-whisper/learn/intermediate/initial-prompt-for-domain-vocabulary/)

### 2. whisper.cpp (ggml-org)

- **Model sizes/disk**: tiny 75MiB, base 142MiB, small 466MiB, medium 1.5GiB, large 2.9GiB (ggml quantized weights). [GitHub](https://github.com/ggml-org/whisper.cpp)
- **Memory**: tiny ~273MB, base ~388MB, small ~852MB, medium ~2.1GB, large ~3.9GB RAM. [GitHub](https://github.com/ggml-org/whisper.cpp)
- **Latency/paradigm**: primarily VAD/chunk-segmented batch processing via the core API; `whisper-stream` tool provides live-mic transcription (segment-by-segment, not token-level streaming partials). [GitHub](https://github.com/ggml-org/whisper.cpp)
- **RTF on Apple Silicon (Metal)**: community/blog figures (not whisper.cpp official README) report M1: tiny ~32x real-time, base ~20x, small ~12x, medium ~5x real-time with Metal; small model RTF ≈0.10 (30s clip in ~3.0s) on M1 8-core GPU. [promptquorum.com](https://www.promptquorum.com/local-llms/apple-silicon-whisper-metal-benchmark) — note: this is a secondary/aggregator source, not the official repo, so treat as indicative only.
- **Metal vs CPU-only speedup on M1**: tiny 1.3x, base 1.9x, large-v3-turbo 2.1x (same aggregator source, unconfirmed against primary repo benchmarks). [promptquorum.com](https://www.promptquorum.com/local-llms/apple-silicon-whisper-metal-benchmark)
- **CoreML**: can be 15-20% faster than Metal on some workloads by offloading the encoder to the Apple Neural Engine, requiring model conversion (reported 2-3x throughput lift on small/base/medium vs CPU-only in aggregator sources) — again secondary-source, not officially benchmarked in the repo README. [getspeakup.app](https://getspeakup.app/blog/whisper-cpp-benchmark-mac/)
- **CUDA on RTX GPUs**: RTX 4070 ≈8x real-time for large-v3; RTX 4090 up to ~60x (optimized config), with small model doing an 11s clip in 0.84s (13.1x) and large-v3 in 3.90s (2.8x) on an RTX 4090 Laptop GPU. No RTX 3070-specific number found; these are 4070/4090 proxies. [gigagpu.com](https://gigagpu.com/whisper-rtf-by-gpu/)
- **Accuracy**: uses the same OpenAI Whisper weights (ggml-converted), so WER matches upstream Whisper numbers per model size; no whisper.cpp-specific accuracy regression documented.
- **Streaming**: via `whisper-stream` example (sliding-window live transcription), not true incremental decoder streaming. [GitHub](https://github.com/ggml-org/whisper.cpp)
- **Language**: multilingual via `.en`-suffixed English-only models or full multilingual models with autodetect; German supported as part of the 99-language multilingual Whisper set. [GitHub](https://github.com/ggml-org/whisper.cpp)
- **License**: MIT. [GitHub](https://github.com/ggml-org/whisper.cpp)
- **Maintenance**: very actively maintained — pushed 2026-10-29 (same day as this research), 54,766 stars, 5,710+ commits, 360 open issues (higher absolute count reflecting large user base). GitHub API, 2026-10-29.
- **Custom vocabulary**: supports `initial_prompt`, grammar-constrained decoding, and hotword-style biasing flags. [GitHub](https://github.com/ggml-org/whisper.cpp)

### 3. MLX Whisper (ml-explore/mlx-examples) and lightning-whisper-mlx

**MLX Whisper**
- **Model sizes**: full OpenAI Whisper range, 39M (tiny) to 1.5B (large), via pre-converted `mlx-community` HF repos (e.g. whisper-tiny-mlx, whisper-base-mlx, whisper-large-mlx). [GitHub](https://github.com/ml-explore/mlx-examples/tree/main/whisper)
- **Paradigm**: batch/file-based CLI and Python API (`mlx_whisper.transcribe`), not a streaming-partials design in the official repo. [GitHub README](https://github.com/ml-explore/mlx-examples/blob/main/whisper/README.md)
- **RTF/benchmarks (community, not official)**: mixed and conflicting reports — one benchmark found mlx-whisper >10x slower than Insanely Fast Whisper on an Nvidia 2080Ti (not a fair apples-to-apples comparison, different HW); another found mlx-whisper 29.7x realtime vs faster-whisper 17.3x realtime on the base model on Apple Silicon (unspecified chip); another found mlx-whisper 1.78x faster than whisper.cpp on M1 Max, while a different test found only 30-40% faster. [Hacker News discussion](https://news.ycombinator.com/item?id=38628184), [owehrens.com](https://owehrens.com/whisper-nvidia-rtx-4090-vs-m1pro-with-mlx/) — flagged as inconsistent/non-authoritative; no single trustworthy RTF number for M1 specifically.
- **License**: mlx-examples repo is MIT-style (Apple's MLX examples are Apache/MIT; exact license not independently re-verified for this subpackage this session) — not fully confirmed, flagged.
- **Maintenance**: mlx-examples repo overall last pushed 2026-04-06 (per GitHub API, 2026-10-29), 9,040 stars, 185 open issues — maintained but noticeably slower cadence than whisper.cpp/faster-whisper.
- **Language/hotwords**: no distinct mechanism documented beyond standard Whisper `initial_prompt` passthrough; not explicitly confirmed in README.

**lightning-whisper-mlx**
- **Model sizes**: tiny, small, distil-small.en, base, medium, distil-medium.en, large, large-v2, distil-large-v2, large-v3, distil-large-v3. [GitHub](https://github.com/mustafaaljadery/lightning-whisper-mlx)
- **Speed claims**: "10x faster than whisper.cpp, 4x faster than [then-current] MLX Whisper" — vendor claim, no raw benchmark table/methodology published in README, so treat as an unverified marketing claim. [GitHub](https://github.com/mustafaaljadery/lightning-whisper-mlx)
- **Paradigm**: batched decoding (higher throughput for batch jobs, not streaming partials); quantized model support for faster memory movement. [GitHub](https://github.com/mustafaaljadery/lightning-whisper-mlx)
- **License**: not found — no LICENSE file/field returned by GitHub API (`"license": null`) or in README content fetched.
- **Maintenance concern**: GitHub API shows `pushed_at: 2024-05-08` — **last commit over 2 years before this research (Oct 2026)**. 958 stars, 19 open issues with no recent activity. This strongly suggests the mustafaaljadery/lightning-whisper-mlx repo is **not actively maintained as of October 2026** (a community fork, sealad886/lightning-whisper-mlx, appears to have more recent activity including a PR for speculative decoding, but that's a third-party fork, not the original). [GitHub API data, 2026-10-29], [sealad886 fork PR](https://github.com/sealad886/lightning-whisper-mlx/pull/1)
- **VRAM/RAM, RTF, WER**: not found — no benchmark numbers with methodology located for this tool specifically.
- **Hotwords/prompting**: not found in available README excerpts.

### 4. WhisperKit (Argmax)

- **Model sizes**: tiny, base, small (English-only and multilingual variants) through large-v3 and large-v3-turbo; flagship recommended model `large-v3-v20240930_626MB` — a compressed CoreML variant shrinking the normal ~1.6GB large-v3 file to 0.6GB while keeping WER within ~1% of the uncompressed model. [GitHub](https://github.com/argmaxinc/WhisperKit), [search summary citing Argmax blog](https://www.argmaxinc.com/blog)
- **Acceleration**: CoreML-based, targets ANE/GPU/CPU on Apple Silicon; macOS 14.0+ required (per the broader Argmax OSS monorepo docs — exact WhisperKit-only minimum wasn't isolated). [argmaxinc/argmax-oss-swift docs]
- **Latency/benchmarks**: Argmax's own benchmark suite (updated every release since WhisperKit-0.9) lives on an interactive HF Space (https://huggingface.co/spaces/argmaxinc/whisperkit-benchmarks) — could not be scraped for exact numeric tables via WebFetch this session (space loads dynamically). One secondary citation claims WhisperKit "matches the lowest latency at 0.46s" and "2.2% WER" vs. cloud ASR systems (gpt-4o-transcribe, Deepgram nova-3, Fireworks large-v3-turbo) but the exact test conditions/hardware were not confirmed from a primary source in this session — flagged as needing direct verification on the HF Space or the WhisperKit arXiv paper (arXiv:2507.10860). [arXiv paper](https://arxiv.org/html/2507.10860v1)
- **M1-specific RTF/WER table**: not found — the interactive HF Space likely has per-device tables but they weren't retrievable via fetch; this is a genuine gap.
- **Streaming**: supports real-time/streaming use via WhisperKit's live transcription APIs and an Argmax CLI local server implementing the OpenAI Audio API with streaming output — more clearly a "true streaming" design than faster-whisper/whisper.cpp's batch-chunk approach, though exact partial-result mechanics weren't independently confirmed from the WhisperKit-specific README (content fetched was from the broader argmax-oss-swift monorepo, not isolated WhisperKit README).
- **Language**: multilingual Whisper weights (99 languages incl. German) — WhisperKit's own README-reported German-specific WER not found; German support confirmed only indirectly via shared Whisper multilingual base and via the sibling TTSKit product explicitly listing German as supported.
- **License**: MIT (with third-party attributions in a NOTICES file). [argmaxinc/argmax-oss-swift]
- **Maintenance**: the GitHub API redirected `argmaxinc/WhisperKit` to a new repository ID (likely renamed/merged into argmaxinc/argmax-oss-swift), consistent with Argmax consolidating WhisperKit, TTSKit, and SpeakerKit into one monorepo — suggests active, ongoing development, but exact last-commit timestamp for WhisperKit specifically wasn't captured due to the redirect.
- **Custom vocabulary**: WhisperKit accepts text prompts to "guide transcription style and context" (prompt-based biasing analogous to Whisper's `initial_prompt`); no separate hotwords mechanism found.

### Accuracy baselines from Open ASR Leaderboard / HF model cards (apply to faster-whisper, whisper.cpp, MLX implementations, and WhisperKit alike since they share base weights)

- **whisper-large-v3-turbo**: Mean WER 7.83, AMI WER 16.13, RTFx 200.19 (Open ASR Leaderboard methodology, per HF model card). 809M params, 99-language multilingual, MIT license. [HF model card](https://huggingface.co/openai/whisper-large-v3-turbo)
- **distil-whisper distil-large-v3**: short-form WER 9.7%, sequential long-form 10.8%, chunked long-form 10.9%, ESB mean 7.52%; RTFx 214.42; "6.3x faster than large-v3"; within ~1% WER of large-v3 on long-form audio; **English-only**; 756M params (~0.8B on disk, safetensors); MIT license (inherited from Whisper). [HF model card](https://huggingface.co/distil-whisper/distil-large-v3)
- **whisper-large-v3** general: LibriSpeech test-clean 2.7% WER, test-other 5.2% WER, Open ASR Leaderboard mean WER 7.44 (secondary-source aggregation, not independently re-verified against the live leaderboard page, which did not render tabular data on fetch). German-specific fine-tuned WER of 2.628% reported for a German fine-tune (not the base model) — base large-v3 zero-shot German WER was not independently found.
- **OpenAI Whisper license**: both code and weights released under **MIT License**, confirmed via the official openai/whisper GitHub repo — no special weight-only restriction, unlike many other foundation model releases. [GitHub](https://github.com/openai/whisper/blob/main/README.md)

### Gaps (could not confirm after reasonable effort)

- WhisperKit: no numeric M1-specific RTF/latency/WER table was retrievable from the interactive HF Space (`argmaxinc/whisperkit-benchmarks`) via automated fetch — needs manual browsing or the raw dataset files in that Space.
- No RTX-3070-specific (non-Ti) number found for faster-whisper, whisper.cpp, or any Whisper variant; closest proxies used were RTX 3070 Ti (faster-whisper official benchmark) and RTX 4070/4090 (whisper.cpp community benchmarks) — explicitly noted above.
- MLX Whisper (mlx-examples) license was not independently re-verified this session (likely MIT/Apache, consistent with other Apple MLX repos, but not directly confirmed from the repo's LICENSE file).
- lightning-whisper-mlx has no confirmed license file at all (GitHub API returned `license: null`), and no RAM/VRAM or WER numbers were found — combined with the 2024-05-08 last-push date, this tool looks effectively unmaintained as of October 2026 and should probably be deprioritized versus MLX Whisper itself or WhisperKit.
- No explicit German-language WER breakdown was found for whisper.cpp, faster-whisper, MLX Whisper, or WhisperKit specifically (as opposed to the shared underlying Whisper weights) — all four tools inherit whatever the base OpenAI Whisper checkpoint's German performance is, since none of them retrain or fine-tune the acoustic model.
- Exact whisper.cpp official (non-aggregator) Metal/CoreML RTF benchmark table, if one exists in the repo's own `docs/`, was not located — the numbers cited above all trace to third-party blogs (promptquorum.com, getspeakup.app), which should be treated as indicative rather than authoritative.
"""The STT server's model store: which catalog models are on disk, downloads (with progress,
cancellable), deletes, and the active model's backend process with hot swapping.

Layout (root = GPU_SPEECH_MODELS, default ~/.cache/gpu-speech/models):

    <root>/<model-id>/...        the model's files; `.complete` once downloaded and converted
    <root>/state.json            {"active": "<model-id>"}, the model to serve after a restart

Downloads and backends are subprocesses: a download is `fetch.py` (killed to cancel), and each
served model runs in its own `stt_backend.py` process in its runtime's venv (onnxruntime on
CUDA 13 and ctranslate2 on CUDA 12 can't share one). Activating a model starts its backend,
waits until it is loaded and warmed up, then swaps it in and stops the old one, so requests keep
being served meanwhile. Only when both wouldn't fit in VRAM is the old one stopped first.
"""
from __future__ import annotations

import json, logging, os, shutil, signal, subprocess, sys, threading, time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Callable

import numpy as np

from catalog import CATALOG, DEFAULT_MODEL, Model

log = logging.getLogger("stt.models")
HERE = Path(__file__).resolve().parent
LEGACY_PARAKEET = Path("~/.cache/gpu-speech/parakeet-tdt-0.6b-v2-onnx").expanduser()
# what two STT backends may hold together; the rest of the 8 GB is the desktop and the TTS
VRAM_BUDGET_MB = int(os.environ.get("STT_VRAM_BUDGET_MB", 6000))
RUNTIME_VENV = {"cu13": ".venv", "cu12": ".venv-whisper"}


class NotReady(Exception):
    pass


@dataclass
class Commands:
    """How to run the steps; tests replace these with fakes."""
    # argv that downloads `model` into a directory (prints `total <bytes>` and `phase <name>`)
    fetch: Callable[[Model, Path], list[str]]
    # argv that installs a runtime's venv, or None when it is installed and up to date
    runtime: Callable[[str], list[str] | None]
    # argv of the backend process serving `model` from a directory
    backend: Callable[[Model, Path], list[str]]
    # directories a runtime adds to the disk (deleted with its last model)
    runtime_dir: Callable[[str], Path | None]


def _runtime_hash(venv: str) -> str:
    import hashlib
    req = HERE / f"requirements{venv.removeprefix('.venv')}.txt"
    return hashlib.sha1(req.read_bytes() + (HERE / "env.sh").read_bytes()).hexdigest()[:12]


def _runtime_cmd(runtime: str) -> list[str] | None:
    venv = RUNTIME_VENV[runtime]
    marker = HERE / venv / ".req-hash"
    if runtime == "cu13" or (marker.exists() and marker.read_text().strip() == _runtime_hash(venv)):
        return None  # the server's own venv is set up by speech.sh before it starts
    script = f'./env.sh setup && echo {_runtime_hash(venv)} > {venv}/.req-hash'
    return ["bash", "-c", f"cd {HERE} && VENV={venv} {script}"]


DEFAULT_COMMANDS = Commands(
    fetch=lambda m, d: [sys.executable, str(HERE / "fetch.py"), m.id, str(d)],
    runtime=_runtime_cmd,
    backend=lambda m, d: ["bash", "-c", f'cd {HERE} && VENV={RUNTIME_VENV[m.runtime]} exec ./env.sh python stt_backend.py "$0" "$1"',
                          m.id, str(d)],
    runtime_dir=lambda r: HERE / RUNTIME_VENV[r] if r != "cu13" else None,
)


def dir_bytes(p: Path) -> int:
    total = 0
    for root, _, files in os.walk(p):
        for f in files:
            try:
                total += os.lstat(os.path.join(root, f)).st_size
            except OSError:
                pass
    return total


class Download:
    def __init__(self, model: Model):
        self.model = model
        self.phase = "starting"  # runtime | download | convert
        self.total = 0
        self.proc: subprocess.Popen | None = None
        self.cancelled = False


class Backend:
    """One model in its backend process: newline-delimited JSON over stdin/stdout."""

    def __init__(self, model: Model, argv: list[str]):
        self.model = model
        # the server's process group, so run.sh stop reaches it too (env.sh and `nix shell` exec:
        # the pid is the Python process)
        self.proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        self.lock = threading.Lock()
        self.info: dict = {}

    def wait_ready(self, timeout: float) -> None:
        line = self._readline(timeout)
        msg = json.loads(line) if line else {"error": f"exited with {self.proc.poll()}"}
        if not msg.get("ready"):
            self.stop()
            raise RuntimeError(msg.get("error") or f"unexpected: {line[:200]!r}")
        self.info = msg

    def _readline(self, timeout: float) -> bytes:
        result: list[bytes] = []
        t = threading.Thread(target=lambda: result.append(self.proc.stdout.readline()), daemon=True)
        t.start()
        t.join(timeout)
        if t.is_alive():
            self.stop()
            raise RuntimeError(f"no answer after {timeout:.0f} s")
        return result[0] if result else b""

    @property
    def alive(self) -> bool:
        return self.proc.poll() is None

    def transcribe(self, audio: np.ndarray, prompt: str | None, language: str | None) -> dict:
        audio = np.ascontiguousarray(audio, dtype="<f4")
        head = json.dumps({"n": len(audio), "prompt": prompt, "language": language}).encode() + b"\n"
        with self.lock:
            if not self.alive:
                raise NotReady(f"the {self.model.id} backend exited")
            try:
                self.proc.stdin.write(head + audio.tobytes())
                self.proc.stdin.flush()
                line = self._readline(60)
            except (BrokenPipeError, OSError, RuntimeError) as e:
                raise NotReady(f"the {self.model.id} backend failed: {e}") from e
        if not line:
            raise NotReady(f"the {self.model.id} backend exited")
        msg = json.loads(line)
        if "error" in msg:
            raise RuntimeError(msg["error"])
        return msg

    def stop(self) -> None:
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()
        for f in (self.proc.stdin, self.proc.stdout):
            try:
                f.close()
            except OSError:
                pass


class ModelManager:
    def __init__(self, root: Path, commands: Commands = DEFAULT_COMMANDS, *, catalog: list[Model] = CATALOG,
                 default: str = DEFAULT_MODEL, load_timeout: float = 300):
        self.root = root
        self.cmd = commands
        self.catalog = catalog
        self.by_id = {m.id: m for m in catalog}
        self.default = default
        self.load_timeout = load_timeout
        self.lock = threading.RLock()
        self.downloads: dict[str, Download] = {}
        self.errors: dict[str, str] = {}
        self.backend: Backend | None = None
        self.loading: str | None = None
        self.root.mkdir(parents=True, exist_ok=True)

    # ---- state -----------------------------------------------------------------------------

    def model(self, mid: str) -> Model:
        if mid not in self.by_id:
            raise KeyError(mid)
        return self.by_id[mid]

    def dir(self, mid: str) -> Path:
        return self.root / mid

    def downloaded(self, mid: str) -> bool:
        return (self.dir(mid) / ".complete").exists()

    @property
    def active(self) -> str | None:
        b = self.backend
        return b.model.id if b and b.alive else None

    def wanted(self) -> str | None:
        """The model to serve: the last one activated, else the default, if downloaded."""
        try:
            mid = json.loads((self.root / "state.json").read_text()).get("active")
        except (OSError, ValueError):
            mid = None
        for m in (mid, self.default):
            if m in self.by_id and self.downloaded(m):
                return m
        return None

    def _save_wanted(self, mid: str) -> None:
        tmp = self.root / "state.json.tmp"
        tmp.write_text(json.dumps({"active": mid}))
        tmp.replace(self.root / "state.json")

    def status(self, mid: str) -> dict:
        m = self.model(mid)
        dl = self.downloads.get(mid)
        if dl:
            status = "downloading"
        elif self.active == mid:
            status = "active"
        elif self.loading == mid:
            status = "loading"
        elif self.downloaded(mid):
            status = "ready"
        else:
            status = "absent"
        progress = None
        if dl:
            done = dir_bytes(self.dir(mid)) if dl.phase == "download" else 0
            progress = {"phase": dl.phase, "done_bytes": done, "total_bytes": dl.total,
                        "fraction": round(min(done / dl.total, 1), 3) if dl.total and dl.phase == "download" else None}
        d = asdict(m)
        for k in ("files", "extra", "onnx_asr_name", "fp16", "whisper_language", "repo"):
            d.pop(k)
        return {**d, "status": status, "progress": progress, "error": self.errors.get(mid),
                "disk_mb": round(dir_bytes(self.dir(mid)) / 2**20) if self.dir(mid).exists() else 0}

    def list(self) -> dict:
        with self.lock:
            runtimes = {}
            for r in sorted({m.runtime for m in self.catalog}):
                d = self.cmd.runtime_dir(r)
                if d is not None:
                    runtimes[r] = {"installed": d.exists(), "disk_mb": round(dir_bytes(d) / 2**20) if d.exists() else 0}
            return {"active": self.active, "loading": self.loading, "default": self.default,
                    "models": [self.status(m.id) for m in self.catalog], "runtimes": runtimes}

    # ---- downloads -------------------------------------------------------------------------

    def download(self, mid: str) -> dict:
        m = self.model(mid)
        with self.lock:
            if mid in self.downloads or self.downloaded(mid):
                return self.status(mid)
            dl = self.downloads[mid] = Download(m)
            self.errors.pop(mid, None)
        threading.Thread(target=self._run_download, args=(dl,), name=f"download-{mid}", daemon=True).start()
        return self.status(mid)

    def _run_download(self, dl: Download) -> None:
        m, d = dl.model, self.dir(dl.model.id)
        try:
            runtime = self.cmd.runtime(m.runtime)
            if runtime:
                dl.phase = "runtime"
                self._step(dl, runtime)
            dl.phase = "download"
            self._step(dl, self.cmd.fetch(m, d))
            (d / ".complete").write_text(time.strftime("%Y-%m-%d %H:%M:%S"))
            log.info("downloaded %s (%d MiB)", m.id, dir_bytes(d) >> 20)
        except Exception as e:
            if dl.cancelled:
                log.info("download of %s cancelled", m.id)
                shutil.rmtree(d, ignore_errors=True)
            else:
                log.warning("download of %s failed: %s", m.id, e)
                self.errors[m.id] = f"Download failed: {e}"
        finally:
            with self.lock:
                self.downloads.pop(m.id, None)

    def _step(self, dl: Download, argv: list[str]) -> None:
        if dl.cancelled:
            raise RuntimeError("cancelled")
        # own process group, so cancel() reaches its children (nix shell, uv, the fp16 converter)
        dl.proc = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True,
                                   text=True)
        tail: list[str] = []
        for line in dl.proc.stdout:
            line = line.strip()
            if line.startswith("total "):
                dl.total = int(line.split()[1])
            elif line.startswith("phase "):
                dl.phase = line.split()[1]
            elif line:
                tail = (tail + [line])[-5:]
        code = dl.proc.wait()
        if code != 0:
            raise RuntimeError("cancelled" if dl.cancelled else (tail[-1] if tail else f"exit {code}"))

    def cancel(self, mid: str) -> dict:
        with self.lock:
            dl = self.downloads.get(mid)
            if dl:
                dl.cancelled = True
                if dl.proc and dl.proc.poll() is None:
                    try:
                        os.killpg(dl.proc.pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
        return self.status(mid)

    def delete(self, mid: str) -> dict:
        m = self.model(mid)
        with self.lock:
            if mid in self.downloads:
                raise ValueError("it is downloading: cancel the download first")
            if self.active == mid or self.loading == mid:
                raise ValueError("it is the active model: switch to another one first")
            shutil.rmtree(self.dir(mid), ignore_errors=True)
            self.errors.pop(mid, None)
            # the last model of a runtime takes the runtime with it
            rdir = self.cmd.runtime_dir(m.runtime)
            if rdir is not None and rdir.exists() and not any(
                    o.runtime == m.runtime and (self.dir(o.id).exists() or o.id in self.downloads)
                    for o in self.catalog):
                shutil.rmtree(rdir, ignore_errors=True)
                log.info("deleted the %s runtime (%s)", m.runtime, rdir)
            log.info("deleted %s", mid)
            return self.status(mid)

    # ---- serving ---------------------------------------------------------------------------

    def activate(self, mid: str, *, wait: bool = False) -> dict:
        self.model(mid)
        with self.lock:
            if not self.downloaded(mid):
                raise ValueError("download it first")
            if self.active == mid or self.loading == mid:
                return self.status(mid)
            if self.loading:
                raise ValueError(f"{self.loading} is still loading")
            self.loading = mid
            self.errors.pop(mid, None)
        t = threading.Thread(target=self._run_activate, args=(mid,), name=f"activate-{mid}", daemon=True)
        t.start()
        if wait:
            t.join()
        return self.status(mid)

    def _run_activate(self, mid: str) -> None:
        m = self.model(mid)
        old = self.backend
        try:
            if old and old.alive and old.model.vram_mb + m.vram_mb > VRAM_BUDGET_MB:
                log.info("stopping %s first: both won't fit in VRAM", old.model.id)
                with old.lock:
                    self.backend = None
                    old.stop()
            t = time.perf_counter()
            new = Backend(m, self.cmd.backend(m, self.dir(mid)))
            new.wait_ready(self.load_timeout)
            with self.lock:
                old, self.backend = self.backend, new
            self._save_wanted(mid)
            log.info("serving %s (loaded in %.1f s)", mid, time.perf_counter() - t)
            if old:
                with old.lock:  # let a running request finish
                    old.stop()
        except Exception as e:
            log.warning("could not load %s: %s", mid, e)
            self.errors[mid] = f"Could not load it: {e}"
        finally:
            with self.lock:
                self.loading = None

    def transcribe(self, audio: np.ndarray, prompt: str | None = None, language: str | None = None) -> dict:
        b = self.backend
        if b is None or not b.alive:
            raise NotReady(f"switching to {self.loading}" if self.loading else "no model is loaded")
        return {"model": b.model.id, **b.transcribe(audio, prompt, language)}

    def start(self, *, wait: bool = True) -> None:
        """Serve the wanted model (after migrating a pre-catalog Parakeet directory)."""
        self.migrate_legacy()
        mid = self.wanted()
        if mid:
            self.activate(mid, wait=wait)
        else:
            log.warning("no STT model downloaded; download one through /v1/stt/models")

    def migrate_legacy(self) -> None:
        """The server before the catalog kept Parakeet v2 in ~/.cache/gpu-speech/<name>-onnx."""
        new = self.dir(DEFAULT_MODEL)
        if DEFAULT_MODEL in self.by_id and LEGACY_PARAKEET.is_dir() and not new.exists() and \
                (LEGACY_PARAKEET / "encoder-model.fp16.onnx.data").exists():
            LEGACY_PARAKEET.rename(new)
            for f in ("encoder-model.onnx", "encoder-model.onnx.data"):
                (new / f).unlink(missing_ok=True)
            shutil.rmtree(new / ".cache", ignore_errors=True)
            (new / ".complete").write_text("migrated")
            log.info("moved %s to %s", LEGACY_PARAKEET, new)

    def stop(self) -> None:
        with self.lock:
            for mid in list(self.downloads):
                self.cancel(mid)
            b, self.backend = self.backend, None
        if b:
            b.stop()

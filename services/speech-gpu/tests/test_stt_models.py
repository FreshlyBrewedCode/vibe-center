"""The STT server's model catalog API: download state machine, cancel, activate (hot swap),
delete, and transcriptions served by the active model. Fake steps (fake_steps.py) stand in for
Hugging Face downloads and GPU backends."""
import io
import sys
import time
import wave
from dataclasses import replace
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from catalog import CATALOG, DEFAULT_MODEL
from models import Commands, ModelManager
from stt_server import create_app

FAKE = str(Path(__file__).with_name("fake_steps.py"))
EN = replace(CATALOG[0], id="en-small", runtime="cu13", vram_mb=1000)
MULTI = replace(CATALOG[1], id="multi", runtime="cu13", vram_mb=1000)
WHISPER = replace(CATALOG[2], id="whisper", runtime="cu12", vram_mb=1000)
BIG = replace(CATALOG[1], id="big", runtime="cu13", vram_mb=5500)


def commands(tmp: Path, fetch_mode: dict[str, str] | None = None, backend_mode: dict[str, str] | None = None):
    fetch_mode, backend_mode = fetch_mode or {}, backend_mode or {}
    runtime_dir = tmp / "venv-cu12"
    return Commands(
        fetch=lambda m, d: [sys.executable, FAKE, "fetch", str(d), fetch_mode.get(m.id, "")],
        runtime=lambda r: None if r == "cu13" or runtime_dir.exists() else [sys.executable, FAKE, "runtime", str(runtime_dir)],
        backend=lambda m, d: [sys.executable, FAKE, "backend", m.id, backend_mode.get(m.id, "")],
        runtime_dir=lambda r: runtime_dir if r == "cu12" else None,
    )


@pytest.fixture
def mm(tmp_path):
    m = ModelManager(tmp_path / "models", commands(tmp_path), catalog=[EN, MULTI, WHISPER, BIG], default="en-small",
                     load_timeout=20)
    yield m
    m.stop()


def wait_for(fn, timeout=10.0):
    end = time.time() + timeout
    while time.time() < end:
        if fn():
            return
        time.sleep(0.02)
    raise AssertionError("timed out")


def status(mm, mid):
    return next(m for m in mm.list()["models"] if m["id"] == mid)


def wav(seconds=1.0, sr=16000) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(b"\0\1" * int(seconds * sr))
    return buf.getvalue()


def test_the_catalog_lists_every_model_with_its_picker_fields():
    ids = [m.id for m in CATALOG]
    assert DEFAULT_MODEL in ids and len(ids) == len(set(ids))
    for m in CATALOG:
        assert m.languages and m.accuracy and m.latency_ms > 0 and m.vram_mb > 0
        assert m.runtime in ("cu13", "cu12") and m.backend in ("onnx-asr", "faster-whisper")
    assert sum(m.recommended for m in CATALOG) == 1


def test_nothing_is_downloaded_until_asked(mm):
    listing = mm.list()
    assert listing["active"] is None and listing["default"] == "en-small"
    assert {m["status"] for m in listing["models"]} == {"absent"}
    assert listing["runtimes"] == {"cu12": {"installed": False, "disk_mb": 0}}
    assert mm.wanted() is None


def test_download_goes_absent_downloading_ready_with_progress(mm, tmp_path):
    mm.cmd = commands(tmp_path, fetch_mode={"en-small": "slow"})
    s = mm.download("en-small")
    assert s["status"] == "downloading"
    wait_for(lambda: (status(mm, "en-small")["progress"] or {}).get("done_bytes", 0) > 0)
    p = status(mm, "en-small")["progress"]
    assert p["phase"] == "download" and p["total_bytes"] == 300_000 and 0 < p["fraction"] < 1
    assert mm.download("en-small")["status"] == "downloading"  # idempotent
    wait_for(lambda: status(mm, "en-small")["status"] == "ready", 15)
    s = status(mm, "en-small")
    assert s["progress"] is None and s["error"] is None and s["disk_mb"] >= 0
    assert mm.downloaded("en-small") and mm.wanted() == "en-small"


def test_a_cancelled_download_leaves_nothing_behind(mm, tmp_path):
    mm.cmd = commands(tmp_path, fetch_mode={"multi": "slow"})
    mm.download("multi")
    wait_for(lambda: (status(mm, "multi")["progress"] or {}).get("done_bytes", 0) > 0)
    mm.cancel("multi")
    wait_for(lambda: status(mm, "multi")["status"] == "absent")
    assert not mm.dir("multi").exists() and status(mm, "multi")["error"] is None


def test_a_failed_download_reports_why(mm, tmp_path):
    mm.cmd = commands(tmp_path, fetch_mode={"multi": "fail"})
    mm.download("multi")
    wait_for(lambda: status(mm, "multi")["status"] == "absent" and status(mm, "multi")["error"])
    assert "HTTP 404" in status(mm, "multi")["error"]


def test_a_cu12_model_installs_its_runtime_first_and_deleting_it_removes_the_runtime(mm, tmp_path):
    mm.download("whisper")
    wait_for(lambda: status(mm, "whisper")["status"] == "ready")
    assert mm.list()["runtimes"]["cu12"]["installed"]
    mm.delete("whisper")
    assert status(mm, "whisper")["status"] == "absent"
    assert not mm.list()["runtimes"]["cu12"]["installed"]


def test_activate_serves_the_model_and_hot_swaps(mm):
    for mid in ("en-small", "multi"):
        mm.download(mid)
    wait_for(lambda: mm.downloaded("en-small") and mm.downloaded("multi"))
    with pytest.raises(ValueError):
        mm.activate("whisper")  # not downloaded
    mm.activate("en-small", wait=True)
    assert mm.active == "en-small" and status(mm, "en-small")["status"] == "active"
    old = mm.backend
    import numpy as np

    assert mm.transcribe(np.zeros(16000, np.float32))["text"].startswith("en-small heard 16000")
    mm.activate("multi", wait=True)
    assert mm.active == "multi" and status(mm, "en-small")["status"] == "ready"
    assert not old.alive  # the old backend was stopped after the swap
    assert mm.transcribe(np.zeros(800, np.float32), prompt="Jeff, Ben")["text"] == "multi heard 800 samples with Jeff, Ben"
    with pytest.raises(ValueError):
        mm.delete("multi")  # active
    mm.delete("en-small")
    assert status(mm, "en-small")["status"] == "absent"
    # after a restart the last activated model is served again
    mm.stop()
    fresh = ModelManager(mm.root, mm.cmd, catalog=mm.catalog, default="en-small")
    try:
        fresh.start(wait=True)
        assert fresh.active == "multi"
    finally:
        fresh.stop()


def test_a_model_that_does_not_fit_next_to_the_old_one_replaces_it(mm):
    for mid in ("en-small", "big"):
        mm.download(mid)
    wait_for(lambda: mm.downloaded("en-small") and mm.downloaded("big"))
    mm.activate("en-small", wait=True)
    old = mm.backend
    mm.activate("big", wait=True)
    assert mm.active == "big" and not old.alive


def test_a_model_that_fails_to_load_keeps_the_old_one_serving(mm, tmp_path):
    mm.cmd = commands(tmp_path, backend_mode={"multi": "fail"})
    for mid in ("en-small", "multi"):
        mm.download(mid)
    wait_for(lambda: mm.downloaded("en-small") and mm.downloaded("multi"))
    mm.activate("en-small", wait=True)
    mm.activate("multi", wait=True)
    assert mm.active == "en-small"
    assert "CUDA out of memory" in status(mm, "multi")["error"]
    assert status(mm, "multi")["status"] == "ready"


def test_http_api(tmp_path):
    mm = ModelManager(tmp_path / "models", commands(tmp_path), catalog=[EN, MULTI, WHISPER], default="en-small",
                      load_timeout=20)
    with TestClient(create_app(mm)) as c:  # nothing downloaded: starts without a model
        assert c.get("/health").status_code == 503
        assert c.post("/v1/audio/transcriptions", files={"file": ("a.wav", wav(), "audio/wav")}).status_code == 503
        assert c.post("/v1/stt/models/nope/download").status_code == 404
        assert c.post("/v1/stt/models/multi/activate").status_code == 409
        assert c.post("/v1/stt/models/en-small/download").status_code == 202
        assert c.post("/v1/stt/models/multi/download").status_code == 202
        wait_for(lambda: all(m["status"] == "ready" for m in c.get("/v1/stt/models").json()["models"][:2]))
        assert c.post("/v1/stt/models/en-small/activate").json()["status"] in ("loading", "active")
        wait_for(lambda: c.get("/health").status_code == 200)
        assert c.get("/health").json() == {"status": "ok", "model": "en-small"}
        r = c.post("/v1/audio/transcriptions", files={"file": ("a.wav", wav(0.5), "audio/wav")},
                   data={"response_format": "verbose_json", "prompt": "Pipecat"})
        assert r.status_code == 200 and r.headers["x-model"] == "en-small"
        assert r.json()["text"] == "en-small heard 8000 samples with Pipecat" and r.json()["model"] == "en-small"
        # switching models changes what is served, without a restart
        c.post("/v1/stt/models/multi/activate")
        wait_for(lambda: c.get("/v1/stt/models").json()["active"] == "multi")
        r = c.post("/v1/audio/transcriptions", files={"file": ("a.wav", wav(1.0, 48000), "audio/wav")})
        assert r.json() == {"text": "multi heard 16000 samples"}
        assert [m["id"] for m in c.get("/v1/models").json()["data"]] == ["multi"]
        assert c.delete("/v1/stt/models/multi").status_code == 409
        assert c.delete("/v1/stt/models/en-small").json()["status"] == "absent"

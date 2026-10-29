"""End-to-end test over the real WebRTC path: headless Chromium with a fake mic file.

    uv run python -m tests.e2e [--backend local|http] [--url URL] [--no-server] [--tailnet-only]

Starts the server (unless --no-server), opens the client page with ?autoconnect, plays the
scenario WAV (tests/scenario.py) as the microphone, injects one proactive event, then checks the
call's latency log: transcripts, replies, a tool call, the barge-in cancel and the event turn.
Prints the analysis and writes tests/out/e2e-<backend>-<ts>.json (browser-side audio onsets too).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import httpx
from playwright.async_api import async_playwright

from voice_loop.config import ROOT

from . import make_audio
from .scenario import EVENT_TEXT

OUT = Path(__file__).resolve().parent / "out"
CHROMIUM = os.environ.get("CHROMIUM", str(ROOT / ".chromium/bin/chromium"))


def start_server(backend: str, port: int, log_dir: Path) -> subprocess.Popen:
    env = {**os.environ, "SPEECH_BACKEND": backend, "PORT": str(port), "LOG_DIR": str(log_dir)}
    log = open(log_dir / "server.log", "w")
    return subprocess.Popen(
        [sys.executable, "-m", "voice_loop.server"], cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT,
        start_new_session=True,
    )


def wait_ready(base: str, timeout: float = 180) -> dict:
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            s = httpx.get(f"{base}/status", timeout=2).json()
            if s.get("talker_pool") == "ready":
                return s
        except Exception:
            pass
        time.sleep(0.5)
    raise TimeoutError("server not ready")


async def drive(url: str, base: str, wav: Path, meta: dict, tailnet_only: bool) -> dict:
    flags = [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        f"--use-file-for-fake-audio-capture={wav}%noloop",
        "--autoplay-policy=no-user-gesture-required",
        "--no-sandbox",
    ]
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=CHROMIUM, headless=True, args=flags)
        page = await browser.new_page()
        page.on("console", lambda m: m.type in ("error", "warning") and print(f"[browser {m.type}] {m.text}"))
        t_open = time.time() * 1000
        await page.goto(f"{url}?autoconnect=1" + ("&ice=tailnet" if tailnet_only else ""))
        await page.wait_for_function("window.vl && window.vl.state === 'connected'", timeout=30000)
        t_conn = await page.evaluate("window.vl.connectedAt")
        print(f"connected after {t_conn - t_open:.0f} ms")
        # The fake mic file starts with getUserMedia, a moment before 'connected'.
        t_mic0 = await page.evaluate("window.vl.audio.length ? window.vl.audio[0].on : null")
        ev_at = next(x["start"] for x in meta["timeline"] if x["id"] == "event")
        end_at = meta["duration"] + 6
        start = time.time()
        injected = None
        while time.time() - start < end_at:
            el = time.time() - start
            if injected is None and el >= ev_at:
                r = httpx.post(f"{base}/event", json={"text": EVENT_TEXT}, timeout=5)
                injected = {"t": time.time() * 1000, "resp": r.json()}
                print(f"[{el:5.1f}s] injected event -> {r.json()}")
            await asyncio.sleep(0.25)
        result = await page.evaluate(
            "({audio: window.vl.audio, events: window.vl.events, connectedAt: window.vl.connectedAt})"
        )
        result["pair"] = await page.evaluate("window.vlPair()")
        print("ICE pair:", result["pair"])
        await page.evaluate("window.vlHangup()")
        await asyncio.sleep(1.5)
        await browser.close()
    result.update({"t_open": t_open, "t_mic0": t_mic0, "injected": injected, "wav_meta": meta})
    return result


def check(call_log: Path, browser: dict) -> list[str]:
    recs = [json.loads(l) for l in call_log.read_text().splitlines() if l.strip()]
    problems = []
    user_turns = [r for r in recs if r["kind"] == "user" and r.get("user_text")]
    if len(user_turns) < 5:
        problems.append(f"expected >=5 transcribed user turns, got {len(user_turns)}")
    if not any(r.get("tools") for r in recs):
        problems.append("no tool call happened")
    if not any(r.get("barge_in_while") for r in recs):
        problems.append("no barge-in recorded")
    if not any(r["t"].get("cancel_sent") for r in recs):
        problems.append("no ACP cancel sent")
    ev = [r for r in recs if r["kind"] == "event"]
    if not ev or not ev[0].get("reply_text"):
        problems.append("proactive event turn missing or unanswered")
    answered = [r for r in user_turns if r.get("reply_text")]
    if len(answered) < 4:
        problems.append(f"expected >=4 answered user turns, got {len(answered)}")
    if not browser["audio"] or not any(a["src"] == "bot" for a in browser["audio"]):
        problems.append("browser never heard bot audio")
    return problems


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--backend", default="local", choices=["local", "http"])
    ap.add_argument("--port", type=int, default=7861)
    ap.add_argument("--url", help="page URL (default http://127.0.0.1:<port>/)")
    ap.add_argument("--no-server", action="store_true")
    ap.add_argument("--tailnet-only", action="store_true", help="offer only 100.x ICE candidates")
    a = ap.parse_args()

    run_started = time.time()
    stamp = time.strftime("%Y%m%d-%H%M%S")
    run_dir = OUT / f"e2e-{a.backend}-{stamp}"
    run_dir.mkdir(parents=True, exist_ok=True)
    wav, meta = make_audio.build("local")  # same input audio for every backend
    base = f"http://127.0.0.1:{a.port}"
    url = a.url or f"{base}/"
    server = None if a.no_server else start_server(a.backend, a.port, run_dir)
    try:
        print("server:", wait_ready(base))
        browser = asyncio.run(drive(url, base, wav, meta, a.tailnet_only))
    finally:
        if server:
            os.killpg(server.pid, signal.SIGINT)
            try:
                server.wait(20)
            except subprocess.TimeoutExpired:
                os.killpg(server.pid, signal.SIGKILL)
    (run_dir / "browser.json").write_text(json.dumps(browser, indent=1))
    log_dir = run_dir if server else ROOT / "logs"  # --no-server: the running server's LOG_DIR
    logs = sorted(p for p in log_dir.glob("call-*.jsonl") if p.stat().st_mtime > run_started)
    if not logs:
        print("FAIL: no call log written")
        sys.exit(1)
    subprocess.run([sys.executable, "-m", "voice_loop.analyze", str(logs[-1]), "--browser", str(run_dir / "browser.json")])
    problems = check(logs[-1], browser)
    print(f"\nrun dir: {run_dir}")
    if problems:
        print("FAIL:\n  " + "\n  ".join(problems))
        sys.exit(1)
    print("PASS")


if __name__ == "__main__":
    main()

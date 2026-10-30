"""Summarize latency logs: per-stage median/p90 and a per-turn table.

    ./run.sh python -m voice_worker.analyze [<data>/voice/calls/call-*.jsonl ...] [--browser tests/out/.../browser.json] [--md]

All stage times are ms after the user stopped speaking (`speech_end` = VAD stop - stop_secs).
The key number is `first agent audio out`: the first non-filler TTS audio frame leaving
the output transport. With --browser (e2e runs, same clock), the page's own mic/speaker onsets
give the true mouth-to-ear numbers including WebRTC transport and jitter buffer.
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import statistics
from pathlib import Path

from .config import CONFIG

STAGES = [
    ("vad_stop", "VAD stop fired"),
    ("eot_decision", "end-of-turn decision"),
    ("stt_result", "STT result"),
    ("prompt_sent", "prompt sent"),
    ("first_update", "first ACP update"),
    ("first_chunk", "first ACP text chunk"),
    ("filler_out", "filler audio out"),
    ("tts_request", "first sentence to TTS"),
    ("tts_first_audio", "first TTS audio byte"),
    ("first_audio_out", "FIRST AGENT AUDIO OUT"),
]
DELTAS = [
    ("STT (request→text)", "stt_request", "stt_response"),
    ("agent TTFT (prompt→1st chunk)", "prompt_sent", "first_chunk"),
    ("agent 1st update (prompt→usage)", "prompt_sent", "first_update"),
    ("TTS TTFB (sentence→1st byte)", "tts_request", "tts_first_audio"),
    ("TTS→wire (1st byte→frame out)", "tts_first_audio", "first_audio_out"),
    ("barge-in → cancel sent", "barge_in", "cancel_sent"),
]


def pct(xs: list[float], p: float) -> float:
    xs = sorted(xs)
    if not xs:
        return float("nan")
    k = (len(xs) - 1) * p
    lo, hi = int(k), min(int(k) + 1, len(xs) - 1)
    return xs[lo] + (xs[hi] - xs[lo]) * (k - lo)


def load(paths: list[str]) -> list[dict]:
    recs = []
    for p in paths:
        for line in Path(p).read_text().splitlines():
            if line.strip():
                r = json.loads(line)
                if r.get("kind") != "orphan":
                    recs.append(r)
    return recs


def browser_join(recs: list[dict], browser: dict) -> None:
    """Attach mouth-to-ear numbers from the page's audio onsets (same machine clock)."""
    mic = [a for a in browser.get("audio", []) if a["src"] == "mic" and a.get("off")]
    bot = [a for a in browser.get("audio", []) if a["src"] == "bot"]
    for r in recs:
        t = r["t"]
        if "speech_end" not in t:
            continue
        # the page's mic segment that ended just before the server's speech_end
        ends = [m["off"] for m in mic if t["speech_end"] - 1500 < m["off"] < t["speech_end"] + 300]
        if not ends:
            continue
        mouth = max(ends)
        r["browser"] = b = {"mic_end": mouth}
        if "first_audio_out" in t:
            # audio already playing then (a filler, the previous reply): no onset to measure
            if any(
                x["on"] < t["first_audio_out"] - 50 and (x["off"] or 1e18) >= t["first_audio_out"]
                for x in bot
            ):
                continue
            ons = [x["on"] for x in bot if x["on"] >= t["first_audio_out"] - 50]
            if ons:
                b["agent_heard"] = min(ons) - mouth
                b["wire_to_ear"] = min(ons) - t["first_audio_out"]


def rel(r: dict, k: str) -> float | None:
    t = r["t"]
    if "speech_end" in t and k in t:
        return t[k] - t["speech_end"]
    return None


def fmt(v) -> str:
    return "" if v is None else f"{v:.0f}"


def summarize(recs: list[dict], md: bool = False) -> str:
    out = []
    user = [r for r in recs if r["kind"] == "user" and "speech_end" in r["t"]]
    meta = recs[0].get("meta", {}) if recs else {}
    out.append(
        f"stt={meta.get('stt')} tts={meta.get('tts')} "
        f"agent={meta.get('agent')} filler={meta.get('filler')} turns={len(recs)} (user turns with VAD stop: {len(user)})"
    )
    out.append("")
    head = ["stage (ms after user stopped speaking)", "n", "median", "p90", "min", "max"]
    rows = []
    for k, label in STAGES:
        xs = [v for r in user if (v := rel(r, k)) is not None]
        if xs:
            rows.append([label, len(xs), statistics.median(xs), pct(xs, 0.9), min(xs), max(xs)])
    for label, a, b in DELTAS:
        xs = [r["t"][b] - r["t"][a] for r in recs if a in r["t"] and b in r["t"]]
        if xs:
            rows.append([label, len(xs), statistics.median(xs), pct(xs, 0.9), min(xs), max(xs)])
    tool_spans = [tl["end"] - tl["start"] for r in recs for tl in r.get("tools", []) if "end" in tl]
    if tool_spans:
        rows.append(
            [
                "tool call (start→end, ACP)",
                len(tool_spans),
                statistics.median(tool_spans),
                pct(tool_spans, 0.9),
                min(tool_spans),
                max(tool_spans),
            ]
        )
    for key, label in (
        ("agent_heard", "browser: MOUTH→AGENT HEARD"),
        ("wire_to_ear", "browser: frame out→heard"),
    ):
        xs = [r["browser"][key] for r in user if key in r.get("browser", {})]
        if xs:
            rows.append([label, len(xs), statistics.median(xs), pct(xs, 0.9), min(xs), max(xs)])
    out.append(
        _table(head, [[c if isinstance(c, (str, int)) else f"{c:.0f}" for c in row] for row in rows], md)
    )
    out.append("")
    head = [
        "#",
        "kind",
        "eot",
        "stt",
        "prompt",
        "1st chunk",
        "filler",
        "1st tts",
        "AGENT OUT",
        "heard",
        "tools",
        "barge-in",
        "user said",
        "reply",
    ]
    rows = []
    for r in recs:
        tools = ",".join(
            tl["title"] + ("" if tl.get("spoken_before") else "(silent)") for tl in r.get("tools", [])
        )
        said = r.get("user_text") or ("[event] " + r.get("event_text", "") if r["kind"] == "event" else "")
        bi = r.get("barge_in_while", "")
        if r["kind"] == "event":
            t, p0 = r["t"], r["t"].get("prompt_sent")
            ev = [
                fmt(t[k] - p0) if p0 and k in t else ""
                for k in ("first_chunk", "filler_out", "tts_request", "first_audio_out")
            ]
            cells = ["", "", "+0", *ev, ""]
        else:
            cells = [
                fmt(rel(r, k))
                for k in (
                    "eot_decision",
                    "stt_result",
                    "prompt_sent",
                    "first_chunk",
                    "filler_out",
                    "tts_request",
                    "first_audio_out",
                )
            ]
            cells.append(fmt(r.get("browser", {}).get("agent_heard")))
        rows.append(
            [
                str(r["turn"]),
                r["kind"],
                *cells,
                tools,
                bi,
                said[:48],
                (r.get("reply_text") or "")[:60] + (" ✂" if r.get("cancelled") else ""),
            ]
        )
    out.append(_table(head, rows, md))
    return "\n".join(out)


def _table(head: list[str], rows: list[list[str]], md: bool) -> str:
    rows = [[str(c) for c in r] for r in rows]
    if md:
        lines = ["| " + " | ".join(head) + " |", "|" + "|".join("---" for _ in head) + "|"]
        lines += ["| " + " | ".join(r) + " |" for r in rows]
        return "\n".join(lines)
    w = [max(len(h), *(len(r[i]) for r in rows)) if rows else len(h) for i, h in enumerate(head)]
    lines = ["  ".join(h.ljust(w[i]) for i, h in enumerate(head))]
    lines += [
        "  ".join(
            c.ljust(w[i])
            if i in (0, len(head) - 1) or not c.replace(".", "").replace("-", "").isdigit()
            else c.rjust(w[i])
            for i, c in enumerate(r)
        )
        for r in rows
    ]
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("logs", nargs="*")
    ap.add_argument("--browser")
    ap.add_argument(
        "--run",
        action="append",
        default=[],
        help="e2e run dir (call-*.jsonl + browser.json); repeatable, pooled",
    )
    ap.add_argument("--md", action="store_true")
    a = ap.parse_args()
    recs = []
    for d in a.run:
        run = load(sorted(glob.glob(f"{d}/call-*.jsonl")))
        if Path(d, "browser.json").exists():
            browser_join(run, json.loads(Path(d, "browser.json").read_text()))
        recs += run
    if a.logs or not a.run:
        paths = a.logs or sorted(glob.glob(str(CONFIG.log_dir / "call-*.jsonl")), key=os.path.getmtime)[-1:]
        more = load(paths)
        if a.browser:
            browser_join(more, json.loads(Path(a.browser).read_text()))
        recs += more
    print(summarize(recs, a.md))


if __name__ == "__main__":
    main()

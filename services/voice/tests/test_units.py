"""Small pure pieces: code-fence filtering, the latency log, filler cues."""

from __future__ import annotations

import json

from voice_worker.cues import FILLERS, Cues, trim
from voice_worker.latency import TurnLog, summary
from voice_worker.talker import CodeFenceFilter, continued_context


def test_code_fences_and_backticks_are_not_spoken():
    f = CodeFenceFilter()
    chunks = ["Run `ls` like this: ``", "`\nls -la\n``", "` and then done."]
    assert "".join(f.feed(c) for c in chunks) == "Run ls like this:  and then done."


def test_continued_context_quotes_the_cut_off_words():
    assert '"Explain in detail."' in continued_context("Explain in detail.")


def test_turn_log_marks_and_summary(tmp_path):
    log = TurnLog(tmp_path / "call.jsonl", "c1", {"voice": "af_heart"})
    seen = []
    log.listeners.append(seen.append)
    log.new_turn("user")
    log.set("speech_end", 1000.0)
    log.set("eot_decision", 1250.0)
    log.mark("first_audio_out", 3000.0)
    log.mark("first_audio_out", 9999.0)  # mark keeps the first
    log.info(user_text="hi")
    log.new_turn("event")  # flushes the first turn
    log.flush()
    lines = [json.loads(x) for x in (tmp_path / "call.jsonl").read_text().splitlines()]
    assert [r["kind"] for r in lines] == ["user", "event"]
    assert lines[0]["t"]["first_audio_out"] == 3000.0 and lines[0]["meta"] == {"voice": "af_heart"}
    s = summary(seen[0])
    assert s["ms"] == {"eot_decision": 250, "first_audio_out": 2000}
    assert s["turn"] == 1 and s["kind"] == "user"


def test_fillers_rotate_and_can_be_off(tmp_path):
    off = Cues(tmp_path, "af_heart", enabled=False).load()
    assert off.filler() is None
    cues = Cues(tmp_path, "af_heart")
    cues.fillers = [b"a", b"b", b"c", b"d"]  # skip synthesis
    names = [cues.filler()[0] for _ in range(5)]
    assert names == [*FILLERS, FILLERS[0]]


def test_trim_cuts_silence_but_keeps_a_little_padding():
    import struct

    silence, loud = [0] * 2400, [5000] * 240
    pcm = struct.pack(f"<{len(silence) * 2 + len(loud)}h", *silence, *loud, *silence)
    out = trim(pcm, pad_ms=10)  # 10 ms = 240 samples at 24 kHz
    assert len(out) // 2 == 240 + 240 + 239

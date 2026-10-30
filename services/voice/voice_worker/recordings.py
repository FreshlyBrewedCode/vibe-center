"""Opt-in debug recordings: the last N user turns as the STT heard them, with the transcript.

Off unless the app sends `record_turns > 0` with a call (Settings -> Voice). Kept in
<data>/recordings/ as `<id>.wav` (16-bit mono, what was sent to the STT, whole turn) and
`<id>.json` (transcript, call, STT, time). Only the newest N are kept; the app can list, play
and clear them through the worker's API.
"""

from __future__ import annotations

import json
import re
import time
import wave
from pathlib import Path

_ID = re.compile(r"^[0-9]{8}-[0-9]{6}-[0-9a-f-]{1,40}-t[0-9]+$")


class Recordings:
    def __init__(self, root: Path):
        self.root = root
        self._turn_ids: dict[tuple[str, int], str] = {}

    def save(
        self, *, keep: int, call_id: str, turn: int, pcm: bytes, sample_rate: int, text: str, stt: str
    ) -> str:
        """Write (or overwrite: a turn's later, longer transcript) one turn, then prune to `keep`."""
        self.root.mkdir(parents=True, exist_ok=True)
        rid = self._turn_ids.get((call_id, turn))
        if rid is None:
            rid = f"{time.strftime('%Y%m%d-%H%M%S')}-{call_id[:8]}-t{turn}"
            self._turn_ids[(call_id, turn)] = rid
        with wave.open(str(self.root / f"{rid}.wav"), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(sample_rate)
            w.writeframes(pcm)
        meta = {
            "id": rid,
            "call_id": call_id,
            "turn": turn,
            "text": text,
            "stt": stt,
            "duration": round(len(pcm) / 2 / sample_rate, 2),
            "at": int(time.time() * 1000),
        }
        (self.root / f"{rid}.json").write_text(json.dumps(meta))
        self.prune(keep)
        return rid

    def list(self) -> list[dict]:
        """Newest first."""
        out = []
        for p in sorted(self.root.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
            try:
                out.append(json.loads(p.read_text()))
            except (OSError, ValueError):
                continue
        return out

    def wav(self, rid: str) -> Path | None:
        if not _ID.match(rid):
            return None
        p = self.root / f"{rid}.wav"
        return p if p.exists() else None

    def prune(self, keep: int) -> None:
        items = sorted(self.root.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
        for p in items[max(keep, 0) :]:
            p.unlink(missing_ok=True)
            p.with_suffix(".wav").unlink(missing_ok=True)

    def clear(self) -> int:
        n = 0
        if self.root.exists():
            for p in self.root.iterdir():
                if p.suffix in (".wav", ".json"):
                    p.unlink(missing_ok=True)
                    n += p.suffix == ".json"
        return n

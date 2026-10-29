"""Per-turn latency log: one JSON object per turn, appended to logs/<call>.jsonl.

A turn opens when the user starts a new turn (or a proactive event is injected) and is written
when the next one opens or the call ends. `mark()` keeps the first timestamp of a name, `set()`
overwrites, `add()` appends to a list (tool calls). All times are epoch ms.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any, Callable


def now_ms() -> float:
    return time.time() * 1000.0


class TurnLog:
    def __init__(self, path: Path, call_id: str, meta: dict[str, Any]):
        self.path = path
        self.call_id = call_id
        self.meta = meta
        self.turn: dict[str, Any] | None = None
        self._n = 0
        self.listeners: list[Callable[[dict[str, Any]], None]] = []
        path.parent.mkdir(parents=True, exist_ok=True)

    def new_turn(self, kind: str = "user", **fields: Any) -> dict[str, Any]:
        self.flush()
        self._n += 1
        self.turn = {"call": self.call_id, "turn": self._n, "kind": kind, "opened": now_ms(), "t": {}, **fields}
        return self.turn

    def _t(self) -> dict[str, Any]:
        if self.turn is None:
            self.new_turn("orphan")
        return self.turn["t"]  # type: ignore[index]

    def mark(self, name: str, t: float | None = None) -> None:
        self._t().setdefault(name, t if t is not None else now_ms())

    def set(self, name: str, t: float | None = None) -> None:
        self._t()[name] = t if t is not None else now_ms()

    def info(self, **fields: Any) -> None:
        if self.turn is None:
            self.new_turn("orphan")
        self.turn.update(fields)  # type: ignore[union-attr]

    def add(self, name: str, item: dict[str, Any]) -> None:
        if self.turn is None:
            self.new_turn("orphan")
        self.turn.setdefault(name, []).append(item)  # type: ignore[union-attr]

    def has(self, name: str) -> bool:
        return self.turn is not None and name in self.turn["t"]

    def flush(self) -> None:
        if self.turn is None:
            return
        rec = {**self.turn, "meta": self.meta}
        with self.path.open("a") as f:
            f.write(json.dumps(rec) + "\n")
        for fn in self.listeners:
            try:
                fn(rec)
            except Exception:
                pass
        self.turn = None

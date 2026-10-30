"""BridgeTalker's reaction to a prompt stuck behind other work (fake bridge, frames recorded)."""

from __future__ import annotations

import asyncio

from pipecat.frames.frames import TTSSpeakFrame

from voice_worker.bridge import AgentEvent
from voice_worker.cues import Cues
from voice_worker.latency import TurnLog
from voice_worker.talker import (
    APPROVAL_TIMEOUT,
    BUSY_NOTE,
    WAITING_APPROVAL_NOTE,
    BridgeTalker,
)


class FakeStream:
    def __init__(self, script):
        self.id = "p1"
        self._script = script

    def __aiter__(self):
        return self._events()

    async def _events(self):
        for item in self._script:
            if isinstance(item, float):
                await asyncio.sleep(item)
            else:
                yield item


class FakeBridge:
    def __init__(self, script):
        self.script = script
        self.cancelled: list[str] = []

    def prompt(self, text, kind="user", context=None):
        return FakeStream(self.script)

    def cancel(self, prompt_id):
        self.cancelled.append(prompt_id)


async def spoken(tmp_path, script, timeout_s=5.0):
    bridge = FakeBridge(script)
    cues = Cues(tmp_path, "af_heart", enabled=False)
    log = TurnLog(tmp_path / "call.jsonl", "c1", {})
    log.new_turn("user")
    talker = BridgeTalker(bridge=bridge, log=log, cues=cues, prompt_timeout_s=timeout_s)
    pushed = []

    async def push_frame(frame, direction=None):
        pushed.append(frame)

    talker.push_frame = push_frame
    talker._gen = 1
    await talker._run_prompt("hello", "user", None, 1)
    return [f.text for f in pushed if isinstance(f, TTSSpeakFrame)], bridge


async def test_waiting_for_approval_is_said_once_then_the_reply_follows(tmp_path):
    says, _ = await spoken(
        tmp_path,
        [
            AgentEvent("started"),
            AgentEvent("waiting", status="permission", title="rm -rf build"),
            AgentEvent("waiting", status="permission", title="rm -rf build"),
            AgentEvent("waiting", status="busy"),
            AgentEvent("text", text="Done."),
            AgentEvent("done", status="complete"),
        ],
    )
    assert says == [WAITING_APPROVAL_NOTE, BUSY_NOTE]


async def test_a_blocked_prompt_that_times_out_says_why(tmp_path):
    says, bridge = await spoken(
        tmp_path,
        [AgentEvent("started"), AgentEvent("waiting", status="permission"), 5.0],
        timeout_s=0.2,
    )
    assert says == [WAITING_APPROVAL_NOTE, APPROVAL_TIMEOUT]
    assert bridge.cancelled == ["p1"]

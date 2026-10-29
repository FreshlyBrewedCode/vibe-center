"""The worker's line back into the app: one WebSocket per call.

The worker owns no agent. Its "LLM step" sends the user's words to the app, which prompts the
agent's existing ACP session (`ChatService.prompt`, source "voice") and streams the reply back.
The app gives every call its own bridge URL and credential in `POST /calls`.

Worker → app frames (JSON):
    {"type": "prompt", "id", "text", "kind": "user"|"event", "context"?}   start a turn
    {"type": "cancel", "id"}                                                barge-in
    {"type": "state", "state": "listening"|"thinking"|"speaking"}           call UI, presence
    {"type": "latency", "turn", "kind", "ms": {...}, ...}                   per-turn summary
App → worker frames:
    {"type": "hello", "callId", "agentName"}
    {"type": "started", "id", "turnId"}       the turn exists (queued or running)
    {"type": "usage", "id"}                   first sign of life from the harness
    {"type": "text", "id", "text"}            reply text chunk
    {"type": "tool", "id", "toolCallId", "title", "status": "start"|"end"}
    {"type": "permission", "id", "title"}     the agent waits for approval in the app
    {"type": "done", "id", "status": "complete"|"cancelled"|"error", "error"?}
    {"type": "event", "text"}                 proactive event: speak it when the line is quiet
    {"type": "end", "reason"?}                hang up
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import uuid
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field
from typing import Any

import aiohttp
from loguru import logger

from .latency import now_ms


@dataclass
class AgentEvent:
    kind: str  # started | usage | text | tool_start | tool_end | permission | done | error
    t: float = field(default_factory=now_ms)
    text: str = ""
    tool_id: str = ""
    title: str = ""
    status: str = ""


class BridgeError(Exception):
    pass


class PromptStream:
    """The events of one turn. Iterate until a `done` or `error` event."""

    def __init__(self, bridge: Bridge, prompt_id: str):
        self.id = prompt_id
        self._bridge = bridge
        self._q: asyncio.Queue[AgentEvent] = asyncio.Queue()
        self.finished = False

    def _push(self, ev: AgentEvent) -> None:
        if not self.finished:
            self._q.put_nowait(ev)

    def __aiter__(self) -> AsyncIterator[AgentEvent]:
        return self._iter()

    async def _iter(self) -> AsyncIterator[AgentEvent]:
        try:
            while True:
                ev = await self._q.get()
                yield ev
                if ev.kind in ("done", "error"):
                    return
        finally:
            self.finished = True
            self._bridge._streams.pop(self.id, None)


class Bridge:
    def __init__(self, session: aiohttp.ClientSession, ws: aiohttp.ClientWebSocketResponse):
        self._session = session
        self._ws = ws
        self._streams: dict[str, PromptStream] = {}
        self._out: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
        self._tasks: list[asyncio.Task] = []
        self.hello: dict[str, Any] = {}
        self.on_event: Callable[[str], None] = lambda text: None
        self.on_end: Callable[[str], None] = lambda reason: None
        self.closed = asyncio.Event()

    @classmethod
    async def connect(cls, url: str, token: str, handshake_s: float = 5.0) -> Bridge:
        session = aiohttp.ClientSession()
        try:
            ws = await session.ws_connect(
                url,
                headers={"Authorization": f"Bearer {token}"},
                heartbeat=15,
                timeout=aiohttp.ClientWSTimeout(ws_receive=None, ws_close=handshake_s),
                max_msg_size=4 * 1024 * 1024,
            )
            bridge = cls(session, ws)
            # the app greets first; it also proves the credential was accepted
            msg = await asyncio.wait_for(ws.receive(), handshake_s)
            if msg.type != aiohttp.WSMsgType.TEXT:
                raise BridgeError(f"bridge closed during handshake ({msg.type.name})")
            bridge.hello = json.loads(msg.data)
            if bridge.hello.get("type") != "hello":
                raise BridgeError(f"unexpected first frame {bridge.hello!r}")
        except Exception as e:
            await session.close()
            if isinstance(e, BridgeError):
                raise
            raise BridgeError(f"cannot reach the app at {url}: {e!r}") from e
        bridge._tasks = [asyncio.create_task(bridge._reader()), asyncio.create_task(bridge._writer())]
        return bridge

    # ---- sending ----------------------------------------------------------------------------

    def send(self, msg: dict[str, Any]) -> None:
        """Queue a frame; frames go out in order. Safe to call from sync code on the loop."""
        if not self.closed.is_set():
            self._out.put_nowait(msg)

    def prompt(self, text: str, kind: str = "user", context: str | None = None) -> PromptStream:
        stream = PromptStream(self, uuid.uuid4().hex[:12])
        self._streams[stream.id] = stream
        if self.closed.is_set():
            stream._push(AgentEvent("error", text="bridge closed"))
            return stream
        msg: dict[str, Any] = {"type": "prompt", "id": stream.id, "text": text, "kind": kind}
        if context:
            msg["context"] = context
        self.send(msg)
        return stream

    def cancel(self, prompt_id: str) -> None:
        self.send({"type": "cancel", "id": prompt_id})

    # ---- loops ------------------------------------------------------------------------------

    async def _writer(self) -> None:
        while True:
            msg = await self._out.get()
            if msg is None:
                return
            try:
                await self._ws.send_str(json.dumps(msg))
            except Exception as e:
                logger.warning(f"bridge send failed: {e!r}")
                return

    async def _reader(self) -> None:
        reason = "bridge closed"
        try:
            async for msg in self._ws:
                if msg.type != aiohttp.WSMsgType.TEXT:
                    continue
                try:
                    self._dispatch(json.loads(msg.data))
                except Exception as e:
                    logger.exception(f"bad bridge frame {msg.data[:200]!r}: {e}")
        except Exception as e:
            reason = f"bridge failed: {e!r}"
        finally:
            self.closed.set()
            for s in list(self._streams.values()):
                s._push(AgentEvent("error", text=reason))
            self.on_end(reason)

    def _dispatch(self, m: dict[str, Any]) -> None:
        kind = m.get("type")
        if kind == "event":
            self.on_event(str(m.get("text", "")))
            return
        if kind == "end":
            self.on_end(str(m.get("reason") or "hung up"))
            return
        stream = self._streams.get(str(m.get("id")))
        if stream is None:
            return  # a stream we stopped reading (cancelled prompt) or a stray frame
        if kind == "text":
            stream._push(AgentEvent("text", text=str(m.get("text", ""))))
        elif kind == "tool":
            start = m.get("status") == "start"
            stream._push(
                AgentEvent(
                    "tool_start" if start else "tool_end",
                    tool_id=str(m.get("toolCallId", "")),
                    title=str(m.get("title", "")),
                    status=str(m.get("status", "")),
                )
            )
        elif kind in ("started", "usage"):
            stream._push(AgentEvent(kind))
        elif kind == "permission":
            stream._push(AgentEvent("permission", title=str(m.get("title", ""))))
        elif kind == "done":
            status = str(m.get("status", "complete"))
            if status == "error":
                stream._push(AgentEvent("error", text=str(m.get("error") or "agent error"), status=status))
            else:
                stream._push(AgentEvent("done", status=status))

    async def close(self) -> None:
        self._out.put_nowait(None)
        with contextlib.suppress(Exception):
            await asyncio.wait_for(self._tasks[1], 1) if len(self._tasks) > 1 else None
        with contextlib.suppress(Exception):
            await self._ws.close()
        for t in self._tasks:
            t.cancel()
        await self._session.close()
        self.closed.set()

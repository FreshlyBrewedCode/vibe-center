"""The bridge client against an in-process stand-in for the app's /voice/bridge endpoint."""

from __future__ import annotations

import asyncio
import json

import pytest
from aiohttp import WSMsgType, web

from voice_worker.bridge import Bridge, BridgeError

TOKEN = "call-secret"


class FakeApp:
    """Speaks the app side of the protocol: answers each prompt with a scripted turn."""

    def __init__(self):
        self.received: list[dict] = []
        self.ws: web.WebSocketResponse | None = None
        self.hold = asyncio.Event()  # set to let a held ("slow") prompt finish

    async def handler(self, request: web.Request):
        if request.headers.get("Authorization") != f"Bearer {TOKEN}":
            return web.Response(status=401)
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        self.ws = ws
        await ws.send_json({"type": "hello", "callId": "c1", "agentName": "Echo"})
        async for msg in ws:
            if msg.type != WSMsgType.TEXT:
                continue
            m = json.loads(msg.data)
            self.received.append(m)
            if m["type"] == "prompt":
                asyncio.create_task(self.turn(ws, m))
            elif m["type"] == "cancel":
                self.hold.set()
        return ws

    async def turn(self, ws: web.WebSocketResponse, m: dict):
        pid = m["id"]
        await ws.send_json({"type": "started", "id": pid, "turnId": "t1"})
        await ws.send_json({"type": "usage", "id": pid})
        if "slow" in m["text"]:
            await self.hold.wait()
            await ws.send_json({"type": "done", "id": pid, "status": "cancelled"})
            return
        if "blocked" in m["text"]:
            await ws.send_json(
                {"type": "waiting", "id": pid, "reason": "permission", "title": "rm -rf build"}
            )
            await ws.send_json({"type": "waiting", "id": pid, "reason": "busy", "title": None})
            await ws.send_json({"type": "done", "id": pid, "status": "complete"})
            return
        if "fail" in m["text"]:
            await ws.send_json({"type": "done", "id": pid, "status": "error", "error": "harness crashed"})
            return
        await ws.send_json({"type": "tool", "id": pid, "toolCallId": "x", "title": "Read", "status": "start"})
        await ws.send_json({"type": "tool", "id": pid, "toolCallId": "x", "title": "Read", "status": "end"})
        await ws.send_json({"type": "text", "id": pid, "text": "Echo: "})
        await ws.send_json({"type": "text", "id": pid, "text": m["text"]})
        await ws.send_json({"type": "done", "id": pid, "status": "complete"})


@pytest.fixture
async def app_url():
    fake = FakeApp()
    app = web.Application()
    app.router.add_get("/voice/bridge", fake.handler)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    yield fake, f"ws://127.0.0.1:{port}/voice/bridge"
    await runner.cleanup()


async def collect(stream):
    return [ev async for ev in stream]


async def test_prompt_streams_the_turn(app_url):
    fake, url = app_url
    bridge = await Bridge.connect(url, TOKEN)
    assert bridge.hello["agentName"] == "Echo"
    events = await collect(bridge.prompt("hello", context="(continues)"))
    assert [e.kind for e in events] == ["started", "usage", "tool_start", "tool_end", "text", "text", "done"]
    assert "".join(e.text for e in events if e.kind == "text") == "Echo: hello"
    assert events[2].title == "Read" and events[-1].status == "complete"
    assert fake.received[0] == {
        "type": "prompt",
        "id": events and fake.received[0]["id"],
        "text": "hello",
        "kind": "user",
        "context": "(continues)",
    }
    await bridge.close()


async def test_cancel_and_error(app_url):
    fake, url = app_url
    bridge = await Bridge.connect(url, TOKEN)
    stream = bridge.prompt("a slow one")
    task = asyncio.create_task(collect(stream))
    await asyncio.sleep(0.05)
    bridge.cancel(stream.id)
    events = await asyncio.wait_for(task, 2)
    assert events[-1].kind == "done" and events[-1].status == "cancelled"
    assert {"type": "cancel", "id": stream.id} in fake.received

    events = await collect(bridge.prompt("this will fail"))
    assert events[-1].kind == "error" and "crashed" in events[-1].text
    await bridge.close()


async def test_mark_interrupted(app_url):
    fake, url = app_url
    bridge = await Bridge.connect(url, TOKEN)
    await collect(bridge.prompt("hello"))
    pid = fake.received[0]["id"]
    bridge.mark_interrupted(pid)
    await asyncio.sleep(0.05)
    assert {"type": "interrupted", "id": pid} in fake.received
    await bridge.close()


async def test_waiting_frames(app_url):
    _, url = app_url
    bridge = await Bridge.connect(url, TOKEN)
    events = await collect(bridge.prompt("a blocked one"))
    waiting = [(e.status, e.title) for e in events if e.kind == "waiting"]
    assert waiting == [("permission", "rm -rf build"), ("busy", "")]
    await bridge.close()


async def test_events_end_and_closed_bridge(app_url):
    fake, url = app_url
    bridge = await Bridge.connect(url, TOKEN)
    got, ended = [], []
    bridge.on_event = got.append
    bridge.on_end = ended.append
    assert fake.ws is not None
    await fake.ws.send_json({"type": "event", "text": "the build finished"})
    await fake.ws.send_json({"type": "end", "reason": "hung up"})
    await asyncio.sleep(0.1)
    assert got == ["the build finished"]
    assert ended == ["hung up"]

    # the app goes away mid-turn: the open stream ends with an error instead of hanging
    stream = bridge.prompt("a slow one")
    task = asyncio.create_task(collect(stream))
    await asyncio.sleep(0.05)
    await fake.ws.close()
    events = await asyncio.wait_for(task, 2)
    assert events[-1].kind == "error"
    assert bridge.closed.is_set()
    # prompting a closed bridge fails at once
    assert [e.kind for e in await collect(bridge.prompt("hi"))] == ["error"]
    await bridge.close()


async def test_bad_credential_is_refused(app_url):
    _, url = app_url
    with pytest.raises(BridgeError):
        await Bridge.connect(url, "wrong")

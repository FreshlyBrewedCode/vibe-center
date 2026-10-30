"""The call's STT as Call builds it: settings from the app (vocabulary, language, recordings)
reach the HTTP request, and the CPU fallback is chosen without a server."""

from __future__ import annotations

import httpx

from voice_worker import call as call_module
from voice_worker.call import Call
from voice_worker.config import CallConfig
from voice_worker.latency import TurnLog
from voice_worker.speech import HttpSTTService, LocalWhisperSTTService, pcm_to_wav_bytes


class StubBridge:
    on_event = None
    on_end = None


class StubCues:
    def __init__(self, *a, **kw):
        pass

    def load(self):
        return self


def build(monkeypatch, tmp_path, *, stt_url: str | None, **cfg):
    monkeypatch.setattr(call_module, "Cues", StubCues)
    monkeypatch.setattr(call_module.CONFIG, "data_dir", tmp_path)
    c = Call(
        CallConfig(call_id="c0ffee00-1", bridge_url="ws://x", bridge_token="t", **cfg),
        StubBridge(),
        stt_url=stt_url,
        tts_url=None,
    )
    _, stt, _ = c._build_services()
    return c, stt


async def test_vocabulary_and_language_reach_the_stt_server(monkeypatch, tmp_path):
    _, stt = build(
        monkeypatch,
        tmp_path,
        stt_url="http://stt.test",
        vocabulary=["Vibe Center", "Jeff"],
        stt_language="de",
        record_turns=3,
    )
    assert isinstance(stt, HttpSTTService) and stt._recorder is not None
    seen = {}

    def handler(req: httpx.Request) -> httpx.Response:
        body = req.read().decode("latin-1")
        seen["prompt"] = 'name="prompt"\r\n\r\nVibe Center, Jeff' in body
        seen["language"] = 'name="language"\r\n\r\nde' in body
        return httpx.Response(200, json={"text": "Hallo Jeff", "model": "canary-1b-v2"})

    stt._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    frames = [f async for f in stt.run_stt(pcm_to_wav_bytes(b"\0\0" * 1600, 16000))]
    assert [f.text for f in frames] == ["Hallo Jeff"]
    assert seen == {"prompt": True, "language": True}


async def test_detect_sends_no_language_and_no_recorder_when_off(monkeypatch, tmp_path):
    _, stt = build(monkeypatch, tmp_path, stt_url="http://stt.test", stt_language="")
    assert stt._recorder is None
    sent = {}

    def handler(req: httpx.Request) -> httpx.Response:
        sent["body"] = req.read().decode("latin-1")
        return httpx.Response(200, json={"text": "ok"})

    stt._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    _ = [f async for f in stt.run_stt(pcm_to_wav_bytes(b"\0\0" * 1600, 16000))]
    assert 'name="language"' not in sent["body"] and 'name="prompt"' not in sent["body"]


def test_without_a_server_the_cpu_whisper_transcribes(monkeypatch, tmp_path):
    _, stt = build(monkeypatch, tmp_path, stt_url=None, vocabulary=["Pipecat"])
    assert isinstance(stt, LocalWhisperSTTService) and stt._vocabulary == ["Pipecat"]


def test_the_turn_log_notes_what_the_call_uses(monkeypatch, tmp_path):
    c, _ = build(monkeypatch, tmp_path, stt_url=None, vocabulary=["a", "b"], stt_language="", record_turns=5)
    assert isinstance(c.log, TurnLog)
    assert c.log.meta["vocabulary"] == 2 and c.log.meta["stt_language"] == "detect"
    assert c.log.meta["record_turns"] == 5

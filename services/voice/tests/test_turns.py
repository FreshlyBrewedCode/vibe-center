"""Whole-turn transcription (turns.py) and the debug turn recordings (recordings.py)."""

from __future__ import annotations

from collections.abc import AsyncGenerator

from pipecat.frames.frames import (
    Frame,
    InputAudioRawFrame,
    TranscriptionFrame,
    UserStoppedSpeakingFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.services.settings import STTSettings
from pipecat.services.stt_service import SegmentedSTTService
from pipecat.tests.utils import SleepFrame, run_test

from voice_worker.recordings import Recordings
from voice_worker.turns import TurnAudio, TurnTranscriptionFrame, TurnTranscriptionMixin, TurnUserAggregator

SR = 16000
FRAME = b"\1\0" * 320  # 20 ms


def frames(n: int) -> list[InputAudioRawFrame]:
    return [InputAudioRawFrame(audio=FRAME, sample_rate=SR, num_channels=1) for _ in range(n)]


def test_turn_audio_keeps_preroll_while_quiet_and_everything_in_a_turn():
    t = TurnAudio(SR, preroll_s=0.1, max_s=1.0)
    for _ in range(20):
        t.add(FRAME)
    assert len(t.audio()) == int(0.1 * SR) * 2  # only the pre-roll
    t.speech_started()
    for _ in range(30):  # speech, a pause and more speech: all kept
        t.add(FRAME)
    assert len(t.audio()) == int(0.1 * SR) * 2 + 30 * len(FRAME)
    assert not t.too_long
    for _ in range(25):
        t.add(FRAME)
    assert t.too_long
    t.turn_ended()
    assert len(t.audio()) == int(0.1 * SR) * 2


class FakeSTT(TurnTranscriptionMixin, SegmentedSTTService):
    """Transcribes a segment as the number of 20 ms frames it holds (trailing silence excluded)."""

    def __init__(self, **kw):
        super().__init__(settings=STTSettings(model="fake", language=None), **kw)

    @property
    def wants_wav_segments(self) -> bool:
        return False

    async def run_stt(self, audio: bytes) -> AsyncGenerator[Frame, None]:
        n = (len(audio) - len(self._trailing_silence())) // len(FRAME)
        yield TranscriptionFrame(f"{n} frames", "", "now")


async def test_each_vad_stop_transcribes_the_whole_turn_so_far():
    recorded = []
    stt = FakeSTT(recorder=lambda turn, pcm, sr, text: recorded.append((turn, len(pcm), text)))
    sent = [
        *frames(60),  # 1.2 s of quiet: 1 s of it is the pre-roll
        VADUserStartedSpeakingFrame(),
        *frames(10),
        VADUserStoppedSpeakingFrame(),
        SleepFrame(0.1),
        *frames(15),  # the pause between the two halves, and the second half
        VADUserStartedSpeakingFrame(),
        *frames(5),
        VADUserStoppedSpeakingFrame(),
        SleepFrame(0.1),
        UserStoppedSpeakingFrame(),
        *frames(60),
        VADUserStartedSpeakingFrame(),
        *frames(4),
        VADUserStoppedSpeakingFrame(),
        SleepFrame(0.1),
    ]
    down, _ = await run_test(stt, frames_to_send=sent)
    texts = [f.text for f in down if isinstance(f, TranscriptionFrame)]
    # 50 pre-roll frames + speech; the second transcript covers the pause and both halves
    assert texts == ["60 frames", "80 frames", "54 frames"]
    assert all(isinstance(f, TurnTranscriptionFrame) for f in down if isinstance(f, TranscriptionFrame))
    assert [(turn, text) for turn, _, text in recorded] == [(1, "60 frames"), (1, "80 frames"), (2, "54 frames")]


async def test_the_aggregator_replaces_a_turns_transcript_instead_of_appending():
    agg = TurnUserAggregator(LLMContext())
    await agg._handle_transcription(TurnTranscriptionFrame("Can you check the", "", "now"))
    await agg._handle_transcription(TurnTranscriptionFrame("Can you check the weather for this weekend", "", "now"))
    assert agg.aggregation_string() == "Can you check the weather for this weekend"
    await agg._handle_transcription(TranscriptionFrame("and more", "", "now"))  # plain ones still append
    assert agg.aggregation_string() == "Can you check the weather for this weekend and more"


def test_recordings_keep_the_newest_n_and_overwrite_a_turns_earlier_version(tmp_path):
    rec = Recordings(tmp_path / "rec")
    pcm = b"\0\0" * SR
    rid = rec.save(keep=2, call_id="c0ffee00-1111", turn=1, pcm=pcm, sample_rate=SR, text="Can you", stt="x")
    assert rec.save(keep=2, call_id="c0ffee00-1111", turn=1, pcm=pcm, sample_rate=SR, text="Can you go", stt="x") == rid
    rec.save(keep=2, call_id="c0ffee00-1111", turn=2, pcm=pcm, sample_rate=SR, text="two", stt="x")
    rec.save(keep=2, call_id="c0ffee00-1111", turn=3, pcm=pcm, sample_rate=SR, text="three", stt="x")
    items = rec.list()
    assert [i["text"] for i in items] == ["three", "two"]
    assert items[0]["duration"] == 1.0 and rec.wav(items[0]["id"]) is not None
    assert rec.wav("../../etc/passwd") is None
    assert rec.clear() == 2 and rec.list() == []

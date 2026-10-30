"""Whole-turn transcription: the STT hears the user's turn as one piece, not VAD fragments.

Pipecat's SegmentedSTTService transcribes each VAD segment on its own: every pause longer than
the VAD's stop time (0.2 s) cuts the turn, and each piece is transcribed without the words around
it. Between pieces it keeps only the last second of audio, so a word the VAD didn't flag as
speech (soft, short) more than a second before the next onset is lost. In a real call "Can you
check the weather | for this weekend in Hamburg" came out as "Can you trick the" + "For this
weekend in". Here instead:

- the buffer opens at the turn's first VAD start (with 1 s of pre-roll) and keeps everything,
  pauses included, until the user turn ends (UserStoppedSpeakingFrame from the aggregator)
- at every VAD stop the whole turn so far is transcribed, and the transcript replaces the
  previous one (TurnTranscriptionFrame; TurnUserAggregator replaces instead of appending)
- a turn longer than MAX_TURN_S is committed in pieces, so a monologue doesn't re-transcribe
  minutes of audio at every pause

The VAD and Smart Turn still decide when the turn ends; only what the STT hears changes.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from loguru import logger
from pipecat.audio.utils import pcm_to_wav
from pipecat.frames.frames import (
    Frame,
    InputAudioRawFrame,
    TranscriptionFrame,
    UserAudioRawFrame,
    UserStoppedSpeakingFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.processors.aggregators.llm_response_universal import LLMUserAggregator
from pipecat.processors.frame_processor import FrameDirection

PREROLL_S = 1.0
MAX_TURN_S = 28.0


class TurnAudio:
    """The audio of the current user turn (16-bit mono PCM). Pure: no Pipecat state."""

    def __init__(self, sample_rate: int, *, preroll_s: float = PREROLL_S, max_s: float = MAX_TURN_S):
        self.sample_rate = sample_rate
        self._preroll = int(preroll_s * sample_rate) * 2
        self._max = int(max_s * sample_rate) * 2
        self._buf = bytearray()
        self.open = False

    def add(self, pcm: bytes) -> None:
        self._buf += pcm
        if not self.open and len(self._buf) > self._preroll:
            del self._buf[: len(self._buf) - self._preroll]

    def speech_started(self) -> None:
        self.open = True

    def audio(self) -> bytes:
        """Everything since the turn's first speech, pre-roll included."""
        return bytes(self._buf)

    @property
    def too_long(self) -> bool:
        return len(self._buf) > self._max

    def commit(self) -> None:
        """Drop what has been transcribed for good (a long turn goes on in a new piece)."""
        self._buf.clear()

    def turn_ended(self) -> None:
        self.open = False
        self.add(b"")  # back to a rolling pre-roll


@dataclass
class TurnTranscriptionFrame(TranscriptionFrame):
    """A transcript of the whole turn so far: replaces the turn's earlier transcripts."""


# (turn number, 16-bit mono PCM the STT heard, sample rate, transcript)
TurnRecorder = Callable[[int, bytes, int, str], None]


class TurnTranscriptionMixin:
    """For SegmentedSTTService subclasses: transcribe the whole turn at every VAD stop.

    Put it first in the bases: `class X(TurnTranscriptionMixin, SegmentedSTTService)`.
    `recorder`, if given, gets each turn's audio and transcript (latest version per turn).
    """

    def __init__(self, *args, recorder: TurnRecorder | None = None, **kwargs):
        super().__init__(*args, **kwargs)
        self._turn: TurnAudio | None = None
        self._committed = ""  # transcript of the committed pieces of a long turn
        self._commit_segment = 0  # the segment whose transcript completes a piece
        self._recorder = recorder
        self._turn_no = 1
        self._sent: dict[int, bytes] = {}  # segment number -> the PCM sent for it (recorder only)

    def _turn_audio(self) -> TurnAudio:
        if self._turn is None or self._turn.sample_rate != self.sample_rate:
            self._turn = TurnAudio(self.sample_rate)
        return self._turn

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, UserStoppedSpeakingFrame):
            self._turn_audio().turn_ended()
            self._committed = ""
            self._commit_segment = 0
            self._turn_no += 1

    async def process_audio_frame(self, frame: InputAudioRawFrame, direction: FrameDirection):
        self._user_id = frame.user_id if isinstance(frame, UserAudioRawFrame) else ""
        self._turn_audio().add(frame.audio)

    async def _handle_user_started_speaking(self, frame: VADUserStartedSpeakingFrame):
        self._user_speaking = True
        self._segment_count += 1
        self._turn_audio().speech_started()

    async def _handle_user_stopped_speaking(self, frame: VADUserStoppedSpeakingFrame):
        self._user_speaking = False
        if not self.is_usable:
            return
        turn = self._turn_audio()
        pcm = turn.audio() + self._trailing_silence()
        if turn.too_long:
            turn.commit()
            self._commit_segment = self._segment_count
        if self._recorder:
            self._sent = {self._segment_count: pcm}
        self._record_stt_audio_usage(pcm)
        await self.emit_stt_usage_metrics()
        audio = pcm_to_wav(pcm, self.sample_rate) if self.wants_wav_segments else pcm
        await self._segment_queue.put((audio, self._segment_count))

    async def push_frame(self, frame: Frame, direction: FrameDirection = FrameDirection.DOWNSTREAM):
        if isinstance(frame, TranscriptionFrame) and not isinstance(frame, TurnTranscriptionFrame):
            text = f"{self._committed} {frame.text.strip()}".strip()
            if self._commit_segment and self._transcribing_segment == self._commit_segment:
                self._committed, self._commit_segment = text, 0
            frame = TurnTranscriptionFrame(
                text=text,
                user_id=frame.user_id,
                timestamp=frame.timestamp,
                language=frame.language,
                result=frame.result,
            )
            pcm = self._sent.get(self._transcribing_segment)
            if self._recorder and pcm:
                try:
                    self._recorder(self._turn_no, pcm, self.sample_rate, text)
                except Exception as e:  # a full disk must not cost the turn
                    logger.warning(f"could not keep the turn recording: {e!r}")
        await super().push_frame(frame, direction)


class TurnUserAggregator(LLMUserAggregator):
    """User aggregator whose turn transcript is replaced, not extended, by a whole-turn one."""

    async def _handle_transcription(self, frame: TranscriptionFrame):
        if isinstance(frame, TurnTranscriptionFrame) and frame.text.strip():
            self._aggregation.clear()
        await super()._handle_transcription(frame)

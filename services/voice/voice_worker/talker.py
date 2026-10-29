"""Pipecat side of the call: replaces the LLM step of a standard Pipecat voice pipeline.

    transport.input -> STT -> user aggregator (Silero VAD + Smart Turn v3)
      -> BridgeTalker -> TTS -> transport.output -> OutputTap

- The user aggregator pushes an LLMContextFrame when the user's turn ends; the talker sends the
  new user text to the app over the bridge (the app prompts the agent's ACP session) and streams
  the reply chunks out as LLMTextFrames. The TTS's sentence aggregator turns them into sentences.
- End of the user's turn is silent: no acknowledgement sound.
- A tool call closes the current LLM response (LLMFullResponseEndFrame), which flushes the TTS
  sentence aggregator: a hard sentence break, so "On it.Done" can't glue together, and the
  pre-tool sentence is spoken now instead of waiting for look-ahead text. If nothing was said
  yet in the turn, a cached filler plays.
- An InterruptionFrame (user started speaking) while a prompt runs sends a cancel over the
  bridge (the app sends ACP `session/cancel`); output audio is already dropped by Pipecat.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from dataclasses import dataclass

from loguru import logger
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    CancelFrame,
    EndFrame,
    Frame,
    InterruptionFrame,
    LLMContextFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMTextFrame,
    OutputAudioRawFrame,
    TranscriptionFrame,
    TTSAudioRawFrame,
    TTSSpeakFrame,
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.turns.user_stop import TurnAnalyzerUserTurnStopStrategy

from .bridge import Bridge
from .cues import Cues
from .latency import TurnLog, now_ms
from .speech import TTS_SAMPLE_RATE

APOLOGY = "Sorry, that's taking too long. Could you say that again?"
ERROR_APOLOGY = "Sorry, something went wrong on my side. Could you say that again?"
PERMISSION_NOTE = "I need your approval in the app for that."
INTERRUPTED_CONTEXT = "(I interrupted your previous reply, so I didn't hear all of it.)"
# A proactive event is spoken only after the line has been quiet this long.
EVENT_QUIET_MS = 600


def continued_context(unanswered: str) -> str:
    """Context for a prompt that continues one cancelled before the agent said anything."""
    return f'(This continues my previous message, "{unanswered}", which you had not answered yet.)'


@dataclass
class FillerAudioFrame(OutputAudioRawFrame):
    """A cached filler played when a tool call starts before anything was said."""


class CodeFenceFilter:
    """Streaming filter that drops ```fenced``` code blocks and inline backticks."""

    def __init__(self):
        self.in_fence = False
        self._pending = ""

    def feed(self, text: str) -> str:
        buf = self._pending + text
        self._pending = ""
        out = []
        while buf:
            i = buf.find("```")
            if i < 0:
                # keep a trailing partial fence for the next chunk
                tail = len(buf) - len(buf.rstrip("`"))
                keep, self._pending = (buf[:-tail], buf[-tail:]) if tail else (buf, "")
                if not self.in_fence:
                    out.append(keep)
                break
            if not self.in_fence:
                out.append(buf[:i])
            self.in_fence = not self.in_fence
            buf = buf[i + 3 :]
        return "".join(out).replace("`", "")


class EndOfTurnStop(TurnAnalyzerUserTurnStopStrategy):
    """Smart Turn stop strategy that also logs VAD stop, the end-of-turn decision and STT text."""

    def __init__(self, *, log: TurnLog, **kwargs):
        super().__init__(**kwargs)
        self._log = log
        self._eot_fired = False

    async def _discard_pending_end_of_turn(self):
        self._eot_fired = False
        await super()._discard_pending_end_of_turn()

    def _fire(self, how: str):
        # only between a VAD stop and the end of the turn (a late transcript can also set
        # _turn_complete after the turn ended; that is not a decision)
        if self._turn_complete and self._vad_stopped and not self._eot_fired:
            self._eot_fired = True
            self._log.set("eot_decision")
            self._log.info(eot_by=how)

    async def _handle_vad_user_stopped_speaking(self, frame: VADUserStoppedSpeakingFrame):
        t = now_ms()
        self._log.set("vad_stop", t)
        self._log.set("speech_end", t - frame.stop_secs * 1000)
        await super()._handle_vad_user_stopped_speaking(frame)
        self._fire("vad_stop")

    async def _handle_input_audio(self, frame):
        await super()._handle_input_audio(frame)
        if not self._vad_user_speaking:
            self._fire("silence_timeout")

    async def _handle_transcription(self, frame: TranscriptionFrame):
        self._log.set("stt_result")
        self._log.add("stt_segments", {"t": now_ms(), "text": frame.text})
        await super()._handle_transcription(frame)


class BridgeTalker(FrameProcessor):
    def __init__(
        self,
        *,
        bridge: Bridge,
        log: TurnLog,
        cues: Cues,
        prompt_timeout_s: float,
        on_state: Callable[[str], None] = lambda s: None,
        **kwargs,
    ):
        super().__init__(**kwargs)
        self._bridge = bridge
        self._log = log
        self._cues = cues
        self._timeout = prompt_timeout_s
        self._on_state = on_state
        self._state = ""
        self._gen = 0  # bumped on every new prompt; events of an older prompt are dropped
        self._cancelled_gen = -1  # the prompt generation a barge-in cancelled
        self._prompt_id: str | None = None
        self._prompt_task: asyncio.Task | None = None
        self._prompt_done = asyncio.Event()
        self._prompt_done.set()
        self._user_speaking = False
        self._bot_speaking = False
        self._events: asyncio.Queue[str] = asyncio.Queue()
        self._event_task: asyncio.Task | None = None
        self._interrupted = False  # the last reply was cut off: tell the agent with the next prompt
        self._unanswered = ""  # user text of a prompt cancelled before the agent said anything
        self._prompt_text = ""
        self._spoken_in_prompt = False

    # ---- state ----------------------------------------------------------------------------

    @property
    def busy(self) -> bool:
        return not self._prompt_done.is_set()

    @property
    def idle(self) -> bool:
        return not (self.busy or self._user_speaking or self._bot_speaking)

    def _report_state(self) -> None:
        state = "speaking" if self._bot_speaking else "thinking" if self.busy else "listening"
        if state != self._state:
            self._state = state
            self._on_state(state)

    def inject_event(self, text: str) -> None:
        """Queue a proactive notification; it is prompted once the user and bot are idle."""
        if text.strip():
            self._events.put_nowait(text.strip())

    # ---- frames ---------------------------------------------------------------------------

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if isinstance(frame, LLMContextFrame):
            await self._handle_context(frame)
            return  # consumed: the agent's ACP session keeps the conversation history
        if isinstance(frame, (InterruptionFrame, UserStartedSpeakingFrame)):
            await self._handle_user_started(frame)
        elif isinstance(frame, UserStoppedSpeakingFrame):
            self._user_speaking = False
            self._log.mark("turn_released")
        elif isinstance(frame, BotStartedSpeakingFrame):
            self._bot_speaking = True
            self._report_state()
        elif isinstance(frame, BotStoppedSpeakingFrame):
            self._bot_speaking = False
            if direction == FrameDirection.UPSTREAM:
                self._log.set("bot_stopped")
            self._report_state()
        elif isinstance(frame, (EndFrame, CancelFrame)):
            await self._shutdown()
        await self.push_frame(frame, direction)

    async def _handle_user_started(self, frame: Frame):
        if isinstance(frame, UserStartedSpeakingFrame):
            if self._user_speaking:
                return
            self._user_speaking = True
            self._barge_in()  # logged on the turn being interrupted
            self._log.new_turn("user")
            self._log.mark("user_started")
        else:
            # InterruptionFrame: usually paired with UserStartedSpeakingFrame (then a no-op), but
            # also sent when the user resumes a turn whose prompt already started.
            self._barge_in()

    def _barge_in(self):
        """The user talks over the bot, or while the agent is still working: stop and cancel."""
        cancel = self.busy and self._cancelled_gen != self._gen
        bot_speaking = self._bot_speaking
        if not (cancel or bot_speaking or self._tts_pending()):
            return
        self._log.mark("barge_in")
        self._log.info(
            barge_in_while="bot_speaking" if bot_speaking else "agent_thinking" if cancel else "tts_pending"
        )
        if cancel:
            self._cancel_prompt()
            self._log.mark("cancel_sent")
            if not self._spoken_in_prompt and self._prompt_text:
                # A pause mid-sentence ended the turn early ("Explain in detail." ... "how you
                # would..."): the next prompt says it continues the cancelled one.
                self._unanswered = self._prompt_text
        self._interrupted = bot_speaking or self._spoken_in_prompt

    def _cancel_prompt(self):
        self._cancelled_gen = self._gen
        if self._prompt_id:
            self._bridge.cancel(self._prompt_id)

    def _tts_pending(self) -> bool:
        """The reply's text is out but not all of it has been played yet (TTS still synthesizing)."""
        turn = self._log.turn
        if not turn or not turn.get("tts_sentences"):
            return False
        return turn["t"].get("bot_stopped", 0) < turn["tts_sentences"][-1]["t"]

    async def _handle_context(self, frame: LLMContextFrame):
        texts = []
        for m in frame.context.get_messages():
            if m.get("role") != "user":
                continue
            c = m.get("content")
            if isinstance(c, str):
                texts.append(c)
            elif isinstance(c, list):
                texts.extend(p.get("text", "") for p in c if isinstance(p, dict))
        frame.context.set_messages([])  # history lives in the agent's ACP session
        text = " ".join(t.strip() for t in texts if t and t.strip())
        if not text:
            return
        self._log.info(user_text=text)
        context = []
        if self._unanswered:
            context.append(continued_context(self._unanswered))
            self._unanswered = ""
            self._log.info(merged_with_cancelled=True)
        if self._interrupted:
            # the session believes its whole last reply was heard; it was cut off
            context.append(INTERRUPTED_CONTEXT)
            self._interrupted = False
        self._prompt_text = text
        await self._start_prompt(text, "user", " ".join(context) or None)

    async def _start_prompt(self, text: str, kind: str, context: str | None = None):
        if self.busy:  # a cancelled prompt resolves within ~10 ms; don't overlap prompts
            if self._cancelled_gen != self._gen:
                self._cancel_prompt()
            try:
                await asyncio.wait_for(self._prompt_done.wait(), 3)
            except TimeoutError:
                logger.warning("previous prompt did not resolve after cancel")
        self._gen += 1
        self._spoken_in_prompt = False
        self._prompt_done.clear()
        self._report_state()
        self._prompt_task = self.create_task(self._run_prompt(text, kind, context, self._gen), "agent_prompt")

    async def _run_prompt(self, text: str, kind: str, context: str | None, gen: int):
        log = self._log
        log.mark("prompt_sent")
        log.info(prompt=text, context=context)

        def stale() -> bool:
            return gen != self._gen or gen == self._cancelled_gen

        fence = CodeFenceFilter()
        response_open = False
        spoken = False
        asked_permission = False
        reply = []
        tools: dict[str, dict] = {}
        stream = self._bridge.prompt(text, kind, context)
        self._prompt_id = stream.id
        try:
            async with asyncio.timeout(self._timeout):
                async for ev in stream:
                    if stale():
                        continue  # drain until the cancelled prompt resolves
                    if ev.kind == "usage":
                        log.mark("first_update", ev.t)
                    elif ev.kind == "text":
                        log.mark("first_chunk", ev.t)
                        clean = fence.feed(ev.text)
                        if not clean:
                            continue
                        if not response_open:
                            await self.push_frame(LLMFullResponseStartFrame())
                            response_open = True
                        await self.push_frame(LLMTextFrame(clean))
                        spoken = spoken or bool(clean.strip())
                        self._spoken_in_prompt = self._spoken_in_prompt or spoken
                        reply.append(clean)
                    elif ev.kind == "tool_start":
                        tools[ev.tool_id] = {"title": ev.title, "start": ev.t, "spoken_before": spoken}
                        if response_open:
                            await self.push_frame(LLMFullResponseEndFrame())  # hard sentence break
                            response_open = False
                            reply.append(" ")
                        elif not spoken and not log.has("filler_pushed"):
                            filler = self._cues.filler()
                            if filler:
                                log.mark("filler_pushed")
                                log.info(filler=filler[0])
                                await self.push_frame(
                                    FillerAudioFrame(
                                        audio=filler[1], sample_rate=TTS_SAMPLE_RATE, num_channels=1
                                    )
                                )
                    elif ev.kind == "tool_end":
                        if ev.tool_id in tools:
                            tools[ev.tool_id]["end"] = ev.t
                            tools[ev.tool_id]["status"] = ev.status
                    elif ev.kind == "permission" and not asked_permission:
                        asked_permission = True
                        if response_open:
                            await self.push_frame(LLMFullResponseEndFrame())
                            response_open = False
                        await self.push_frame(TTSSpeakFrame(PERMISSION_NOTE))
                    elif ev.kind == "done":
                        log.info(stop_status=ev.status)
                    elif ev.kind == "error":
                        log.info(error=ev.text)
                        logger.error(f"agent turn failed: {ev.text}")
                        if response_open:
                            await self.push_frame(LLMFullResponseEndFrame())
                            response_open = False
                        await self.push_frame(TTSSpeakFrame(ERROR_APOLOGY))
        except TimeoutError:
            logger.warning(f"prompt timed out after {self._timeout}s; cancelling")
            log.mark("timeout")
            self._bridge.cancel(stream.id)
            if not stale():
                if response_open:
                    await self.push_frame(LLMFullResponseEndFrame())
                    response_open = False
                await self.push_frame(TTSSpeakFrame(APOLOGY))
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.exception(f"prompt failed: {e}")
            log.info(error=str(e))
        finally:
            if response_open and not stale():
                await self.push_frame(LLMFullResponseEndFrame())
            log.mark("prompt_done")
            if tools:
                log.info(tools=list(tools.values()))
            log.info(reply_text="".join(reply).strip(), cancelled=stale())
            if self._prompt_id == stream.id:
                self._prompt_id = None
            self._prompt_done.set()
            self._report_state()

    # ---- proactive events -----------------------------------------------------------------

    async def start_event_loop(self):
        self._report_state()
        self._event_task = self.create_task(self._event_loop(), "proactive_events")

    async def _event_loop(self):
        while True:
            text = await self._events.get()
            # only when nobody is talking and the agent is idle, and it stays so briefly
            quiet_since = None
            while True:
                if self.idle:
                    quiet_since = quiet_since or now_ms()
                    if now_ms() - quiet_since > EVENT_QUIET_MS:
                        break
                else:
                    quiet_since = None
                await asyncio.sleep(0.1)
            self._log.new_turn("event", event_text=text)
            self._prompt_text = ""  # never merged into a later user turn
            await self._start_prompt(text, "event")
            await self._prompt_done.wait()

    async def _shutdown(self):
        if self.busy:
            self._cancel_prompt()
        if self._event_task:
            await self.cancel_task(self._event_task)
            self._event_task = None


class OutputTap(FrameProcessor):
    """After transport.output(): marks when filler and agent audio actually left for the wire."""

    def __init__(self, *, log: TurnLog, **kwargs):
        super().__init__(**kwargs)
        self._log = log

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if direction == FrameDirection.DOWNSTREAM and isinstance(frame, OutputAudioRawFrame):
            log = self._log
            if isinstance(frame, FillerAudioFrame):
                if log.has("filler_pushed"):
                    log.mark("filler_out")
            elif isinstance(frame, TTSAudioRawFrame) and log.has("prompt_sent"):
                log.mark("first_audio_out")
        await self.push_frame(frame, direction)

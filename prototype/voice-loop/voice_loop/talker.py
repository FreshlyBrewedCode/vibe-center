"""Pipecat side of the ACP talker: replaces the LLM step of a standard Pipecat voice pipeline.

    transport.input -> STT -> user aggregator (Silero VAD + Smart Turn v3)
      -> AcpTalkerProcessor -> TTS -> transport.output -> OutputTap

- The user aggregator pushes an LLMContextFrame when the user's turn ends; the talker sends
  the new user text as one ACP `session/prompt` and streams `agent_message_chunk` text out as
  LLMTextFrames. The TTS's sentence aggregator turns them into sentences.
- `EndOfTurnStop` (a Smart Turn stop strategy) calls `on_end_of_turn()` the moment the turn
  analyzer decides the user is done, before STT finishes, and the talker plays the cached ack.
- A tool call closes the current LLM response (LLMFullResponseEndFrame), which flushes the TTS
  sentence aggregator: a hard sentence break, so "On it.Done" can't glue together, and the
  pre-tool sentence is spoken now instead of waiting for look-ahead text. If nothing was said
  yet in the turn, a cached filler plays.
- An InterruptionFrame (user started speaking) while a prompt runs sends `session/cancel`;
  output audio is already dropped by Pipecat's interruption handling.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any, Callable

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

from .acp_talker import AcpTalker
from .config import Config
from .cues import Cues
from .latency import TurnLog, now_ms
from .speech import TTS_SAMPLE_RATE

APOLOGY = "Sorry, that's taking too long. Could you say that again?"
ERROR_APOLOGY = "Sorry, something went wrong on my side. Could you say that again?"


@dataclass
class AckAudioFrame(OutputAudioRawFrame):
    """The cached end-of-turn acknowledgement."""


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
    """Smart Turn stop strategy that also reports VAD stop, the end-of-turn decision and STT text.

    Pipecat only emits UserStoppedSpeakingFrame once the transcript is in; the ack must not
    wait for STT, so the decision itself is surfaced through `on_eot`.
    """

    def __init__(self, *, log: TurnLog, on_eot: Callable[[str], Any], **kwargs):
        super().__init__(**kwargs)
        self._log = log
        self._on_eot = on_eot
        self._eot_fired = False

    async def _discard_pending_end_of_turn(self):
        self._eot_fired = False
        await super()._discard_pending_end_of_turn()

    async def _fire(self, how: str):
        # only between a VAD stop and the end of the turn (a late transcript can also set
        # _turn_complete after the turn ended; that is not a decision)
        if self._turn_complete and self._vad_stopped and not self._eot_fired:
            self._eot_fired = True
            self._log.set("eot_decision")
            self._log.info(eot_by=how)
            await self._on_eot(how)

    async def _handle_vad_user_stopped_speaking(self, frame: VADUserStoppedSpeakingFrame):
        t = now_ms()
        self._log.set("vad_stop", t)
        self._log.set("speech_end", t - frame.stop_secs * 1000)
        await super()._handle_vad_user_stopped_speaking(frame)
        await self._fire("vad_stop")

    async def _handle_input_audio(self, frame):
        await super()._handle_input_audio(frame)
        if not self._vad_user_speaking:
            await self._fire("silence_timeout")

    async def _handle_transcription(self, frame: TranscriptionFrame):
        self._log.set("stt_result")
        self._log.add("stt_segments", {"t": now_ms(), "text": frame.text})
        await super()._handle_transcription(frame)


class AcpTalkerProcessor(FrameProcessor):
    def __init__(
        self,
        *,
        talker: AcpTalker,
        log: TurnLog,
        cues: Cues,
        cfg: Config,
        publish: Callable[[dict], None] = lambda e: None,
        **kwargs,
    ):
        super().__init__(**kwargs)
        self._talker = talker
        self._log = log
        self._cues = cues
        self._cfg = cfg
        self._publish = publish
        self._gen = 0  # bumped on every new prompt; events of an older prompt are dropped
        self._cancelled_gen = -1  # the prompt generation a barge-in cancelled
        self._prompt_task: asyncio.Task | None = None
        self._prompt_done = asyncio.Event()
        self._prompt_done.set()
        self._user_speaking = False
        self._bot_speaking = False
        self._events: asyncio.Queue[str] = asyncio.Queue()
        self._event_task: asyncio.Task | None = None
        self._ack_played_turn: int | None = None
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

    def inject_event(self, text: str) -> None:
        """Queue a proactive notification; it is prompted once the user and bot are idle."""
        self._events.put_nowait(text)

    # ---- frames ---------------------------------------------------------------------------

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if isinstance(frame, LLMContextFrame):
            await self._handle_context(frame)
            return  # consumed: the ACP session keeps the conversation history
        if isinstance(frame, (InterruptionFrame, UserStartedSpeakingFrame)):
            await self._handle_user_started(frame)
        elif isinstance(frame, UserStoppedSpeakingFrame):
            self._user_speaking = False
            self._log.mark("turn_released")
        elif isinstance(frame, BotStartedSpeakingFrame):
            self._bot_speaking = True
        elif isinstance(frame, BotStoppedSpeakingFrame):
            self._bot_speaking = False
            if direction == FrameDirection.UPSTREAM:
                self._log.set("bot_stopped")
        elif isinstance(frame, (EndFrame, CancelFrame)):
            await self._shutdown()
        await self.push_frame(frame, direction)

    async def _handle_user_started(self, frame: Frame):
        if isinstance(frame, UserStartedSpeakingFrame):
            if self._user_speaking:
                return
            self._user_speaking = True
            await self._barge_in()  # logged on the turn being interrupted
            self._log.new_turn("user")
            self._log.mark("user_started")
        else:
            # InterruptionFrame: usually paired with UserStartedSpeakingFrame (then a no-op), but
            # also sent when the user resumes a turn whose prompt already started.
            await self._barge_in()

    async def _barge_in(self):
        """The user talks over the bot, or while the agent is still working: stop and cancel."""
        cancel = self.busy and self._cancelled_gen != self._gen
        # bot audio before any prompt in this turn is just the ack: talking over it is no barge-in
        bot_speaking = self._bot_speaking and self._log.has("prompt_sent")
        if not (cancel or bot_speaking or self._tts_pending()):
            return
        self._log.mark("barge_in")
        self._log.info(
            barge_in_while="bot_speaking" if bot_speaking else "agent_thinking" if cancel else "tts_pending"
        )
        if cancel:
            self._cancelled_gen = self._gen
            await self._talker.cancel()
            self._log.mark("cancel_sent")
            if not self._spoken_in_prompt:
                # A pause mid-sentence ended the turn early ("Explain in detail." ... "how you
                # would..."): the next prompt repeats the cancelled words, so it reads as one turn.
                self._unanswered = self._prompt_text
        self._interrupted = bot_speaking or self._spoken_in_prompt
        self._publish({"type": "barge_in", "bot_speaking": bot_speaking})

    def _tts_pending(self) -> bool:
        """The reply's text is out but not all of it has been played yet (TTS still synthesizing)."""
        turn = self._log.turn
        if not turn or not turn.get("tts_sentences"):
            return False
        return turn["t"].get("bot_stopped", 0) < turn["tts_sentences"][-1]["t"]

    async def on_end_of_turn(self, how: str):
        """Called by EndOfTurnStop when Smart Turn decides the user is done (pre-STT)."""
        if self._cues.ack is None or self._log.turn is None:
            return
        turn_no = self._log.turn["turn"]
        if self._ack_played_turn == turn_no:
            return  # one ack per turn, even if the user resumed and stopped again
        self._ack_played_turn = turn_no
        self._log.mark("ack_pushed")
        await self.push_frame(AckAudioFrame(audio=self._cues.ack, sample_rate=TTS_SAMPLE_RATE, num_channels=1))

    async def _handle_context(self, frame: LLMContextFrame):
        msgs = frame.context.get_messages()
        texts = []
        for m in msgs:
            if m.get("role") != "user":
                continue
            c = m.get("content")
            if isinstance(c, str):
                texts.append(c)
            elif isinstance(c, list):
                texts.extend(p.get("text", "") for p in c if isinstance(p, dict))
        frame.context.set_messages([])  # history lives in the ACP session
        text = " ".join(t.strip() for t in texts if t and t.strip())
        if not text:
            return
        self._log.info(user_text=text)
        self._publish({"type": "user", "text": text})
        if self._unanswered:
            text = f"{self._unanswered} {text}"
            self._unanswered = ""
            self._log.info(merged_with_cancelled=True)
        self._prompt_text = text
        if self._interrupted:
            # the session believes its whole last reply was heard; it was cut off
            text = f"(I interrupted your previous reply.) {text}"
            self._interrupted = False
        await self._start_prompt(text)

    async def _start_prompt(self, text: str):
        if self.busy:  # a cancelled prompt resolves within ~10 ms; don't overlap prompts
            if self._cancelled_gen != self._gen:
                self._cancelled_gen = self._gen
                await self._talker.cancel()
            try:
                await asyncio.wait_for(self._prompt_done.wait(), 3)
            except TimeoutError:
                logger.warning("previous prompt did not resolve after cancel")
        self._gen += 1
        self._spoken_in_prompt = False
        self._prompt_done.clear()
        self._prompt_task = self.create_task(self._run_prompt(text, self._gen), "acp_prompt")

    async def _run_prompt(self, text: str, gen: int):
        log = self._log
        log.mark("prompt_sent")
        log.info(prompt=text)
        stale = lambda: gen != self._gen or gen == self._cancelled_gen  # noqa: E731
        fence = CodeFenceFilter()
        response_open = False
        spoken = False
        reply = []
        tools: dict[str, dict] = {}
        try:
            async with asyncio.timeout(self._cfg.prompt_timeout_s):
                async for ev in self._talker.prompt(text):
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
                        # text glued around a tool call ("On it.Done") is split by the flush below
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
                                    FillerAudioFrame(audio=filler[1], sample_rate=TTS_SAMPLE_RATE, num_channels=1)
                                )
                        self._publish({"type": "tool", "title": ev.title})
                    elif ev.kind == "tool_end":
                        if ev.tool_id in tools:
                            tools[ev.tool_id]["end"] = ev.t
                            tools[ev.tool_id]["status"] = ev.text
                    elif ev.kind == "done":
                        log.info(stop_reason=ev.stop_reason)
                    elif ev.kind == "error":
                        log.info(error=ev.text)
                        logger.error(f"ACP prompt error: {ev.text}")
                        await self.push_frame(TTSSpeakFrame(ERROR_APOLOGY))
        except TimeoutError:
            logger.warning(f"prompt timed out after {self._cfg.prompt_timeout_s}s; cancelling")
            log.mark("timeout")
            await self._talker.cancel()
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
            reply_text = "".join(reply).strip()
            log.info(reply_text=reply_text, cancelled=stale())
            self._publish({"type": "bot", "text": reply_text, "cancelled": stale()})
            self._prompt_done.set()

    # ---- proactive events (stretch) --------------------------------------------------------

    async def start_event_loop(self):
        self._event_task = self.create_task(self._event_loop(), "proactive_events")

    async def _event_loop(self):
        while True:
            text = await self._events.get()
            # only when nobody is talking and the agent is idle, and stays so briefly
            quiet_since = None
            while True:
                if self.idle:
                    quiet_since = quiet_since or now_ms()
                    if now_ms() - quiet_since > 600:
                        break
                else:
                    quiet_since = None
                await asyncio.sleep(0.1)
            self._log.new_turn("event", event_text=text)
            self._prompt_text = ""  # never merged into a later user turn
            self._publish({"type": "event", "text": text})
            await self._start_prompt(f"[event] {text}")
            await self._prompt_done.wait()

    async def _shutdown(self):
        if self.busy:
            self._cancelled_gen = self._gen
            await self._talker.cancel()
        if self._event_task:
            await self.cancel_task(self._event_task)
            self._event_task = None


class OutputTap(FrameProcessor):
    """After transport.output(): marks when ack / filler / agent audio actually left for the wire."""

    def __init__(self, *, log: TurnLog, **kwargs):
        super().__init__(**kwargs)
        self._log = log

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if direction == FrameDirection.DOWNSTREAM and isinstance(frame, OutputAudioRawFrame):
            log = self._log
            if isinstance(frame, AckAudioFrame):
                if log.has("ack_pushed"):
                    log.mark("ack_out")
            elif isinstance(frame, FillerAudioFrame):
                if log.has("filler_pushed"):
                    log.mark("filler_out")
            elif isinstance(frame, TTSAudioRawFrame):
                if log.has("prompt_sent"):
                    log.mark("first_audio_out")
        await self.push_frame(frame, direction)

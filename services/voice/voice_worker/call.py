"""One call: a Pipecat pipeline over a SmallWebRTC connection, its LLM step bridged to the app."""

from __future__ import annotations

import asyncio
import time

from loguru import logger
from pipecat.audio.turn.smart_turn.local_smart_turn_v3 import LocalSmartTurnAnalyzerV3
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import LLMUserAggregator, LLMUserAggregatorParams
from pipecat.transports.base_transport import TransportParams
from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport
from pipecat.turns.user_turn_strategies import UserTurnStrategies

from .bridge import Bridge
from .config import CONFIG, CallConfig
from .cues import Cues
from .latency import TurnLog, summary
from .speech import TTS_SAMPLE_RATE, make_stt, make_tts
from .talker import BridgeTalker, EndOfTurnStop, MicGate, OutputTap


class Call:
    def __init__(self, cfg: CallConfig, bridge: Bridge, *, stt_url: str | None, tts_url: str | None):
        self.cfg = cfg
        self.id = cfg.call_id
        self.bridge = bridge
        self.stt_url = stt_url  # None: local CPU
        self.tts_url = tts_url
        self.processor: BridgeTalker | None = None
        self.muted = False
        self.mic: MicGate | None = None
        self.task: PipelineTask | None = None
        self.started = time.time()
        self._ended = asyncio.Event()
        self._end_reason = ""
        meta = {
            "stt": stt_url or f"faster-whisper {CONFIG.whisper_model} cpu int8",
            "tts": tts_url or "kokoro-onnx cpu",
            "voice": cfg.voice,
            "filler": cfg.filler,
            "agent": cfg.agent_name,
            "vad_stop_secs": CONFIG.vad_stop_secs,
        }
        stamp = time.strftime("%Y%m%d-%H%M%S")
        self.log = TurnLog(CONFIG.log_dir / f"call-{stamp}-{cfg.call_id[:8]}.jsonl", cfg.call_id, meta)
        self.log.listeners.append(self._send_latency)
        bridge.on_event = self._on_event
        bridge.on_mute = self._on_mute
        bridge.on_end = self.end

    def _send_latency(self, rec: dict) -> None:
        if rec["kind"] != "orphan":
            self.bridge.send({"type": "latency", **summary(rec)})

    def _on_event(self, text: str) -> None:
        if self.processor:
            self.processor.inject_event(text)

    def _on_mute(self, muted: bool) -> None:
        self.muted = muted
        if self.mic:
            self.mic.muted = muted

    def end(self, reason: str = "hung up") -> None:
        if self._ended.is_set():
            return
        self._end_reason = reason
        self._ended.set()
        if self.task:
            asyncio.get_running_loop().create_task(self.task.cancel())

    def _build_services(self):
        cues = Cues(CONFIG.cue_dir, self.cfg.voice, self.cfg.filler).load()
        return cues, make_stt(self.stt_url, self.log), make_tts(self.tts_url, self.cfg.voice, self.log)

    async def run(self, connection: SmallWebRTCConnection) -> None:
        try:
            await self._run(connection)
        finally:
            self.log.flush()
            await self.bridge.close()
            logger.info(
                f"call {self.id} ended ({self._end_reason or 'pipeline finished'}); log {self.log.path}"
            )

    async def _run(self, connection: SmallWebRTCConnection) -> None:
        # cue synthesis and model setup block: keep them off the event loop
        cues, stt, tts = await asyncio.to_thread(self._build_services)
        transport = SmallWebRTCTransport(
            webrtc_connection=connection,
            params=TransportParams(
                audio_in_enabled=True,
                audio_out_enabled=True,
                audio_in_sample_rate=16000,
                audio_out_sample_rate=TTS_SAMPLE_RATE,
            ),
        )
        talker = BridgeTalker(
            bridge=self.bridge,
            log=self.log,
            cues=cues,
            prompt_timeout_s=CONFIG.prompt_timeout_s,
            on_state=lambda s: self.bridge.send({"type": "state", "state": s}),
        )
        self.processor = talker
        self.mic = MicGate()
        self.mic.muted = self.muted
        stop = EndOfTurnStop(turn_analyzer=LocalSmartTurnAnalyzerV3(), log=self.log)
        user_agg = LLMUserAggregator(
            LLMContext(),
            params=LLMUserAggregatorParams(
                vad_analyzer=SileroVADAnalyzer(params=VADParams(stop_secs=CONFIG.vad_stop_secs)),
                user_turn_strategies=UserTurnStrategies(stop=[stop]),
                empty_user_turn=None,
            ),
        )
        pipeline = Pipeline(
            [
                transport.input(),
                self.mic,
                stt,
                user_agg,
                talker,
                tts,
                transport.output(),
                OutputTap(log=self.log),
            ]
        )
        self.task = PipelineTask(
            pipeline,
            params=PipelineParams(
                enable_metrics=True, audio_in_sample_rate=16000, audio_out_sample_rate=TTS_SAMPLE_RATE
            ),
            enable_rtvi=False,
            idle_timeout_secs=None,
        )

        @transport.event_handler("on_client_connected")
        async def _connected(_t, _c):
            logger.info(f"call {self.id}: client connected")
            await talker.start_event_loop()

        @transport.event_handler("on_client_disconnected")
        async def _disconnected(_t, _c):
            logger.info(f"call {self.id}: client disconnected")
            self.end("browser disconnected")

        if self._ended.is_set():  # hung up while the services were being built
            return
        await PipelineRunner(handle_sigint=False).run(self.task)

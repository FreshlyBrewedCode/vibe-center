"""One phone call: a Pipecat pipeline over a SmallWebRTC connection, driven by an ACP talker."""

from __future__ import annotations

import asyncio
import time
from typing import Callable

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

from .acp_talker import AcpTalker
from .config import Config
from .cues import Cues
from .latency import TurnLog
from .speech import TTS_SAMPLE_RATE, make_stt, make_tts
from .talker import AcpTalkerProcessor, EndOfTurnStop, OutputTap


class Call:
    def __init__(
        self,
        *,
        connection: SmallWebRTCConnection,
        talker: AcpTalker,
        backend: str,
        cues: Cues,
        cfg: Config,
        publish: Callable[[dict], None],
    ):
        self.id = time.strftime("%Y%m%d-%H%M%S")
        self.connection = connection
        self.talker = talker
        self.backend = backend
        self.cues = cues
        self.cfg = cfg
        self.publish = publish
        self.processor: AcpTalkerProcessor | None = None
        self.task: PipelineTask | None = None
        meta = {
            "backend": backend,
            "stt": cfg.stt_url if backend == "http" else f"faster-whisper {cfg.whisper_model} cpu int8",
            "tts": cfg.tts_url if backend == "http" else "kokoro-onnx cpu",
            "voice": cfg.tts_voice,
            "ack": cfg.ack,
            "filler": cfg.filler,
            "talker_model": talker.model,
            "vad_stop_secs": cfg.vad_stop_secs,
            "talker_ready_ms": talker.ready_ms,
        }
        self.log = TurnLog(cfg.log_dir / f"call-{self.id}.jsonl", self.id, meta)
        self.log.listeners.append(lambda rec: publish({"type": "turn", "turn": rec}))

    def _build_services(self):
        return make_stt(self.backend, self.cfg, self.log), make_tts(self.backend, self.cfg, self.log)

    async def run(self) -> None:
        cfg = self.cfg
        # model loading (whisper, kokoro) is blocking: keep it off the event loop
        stt, tts = await asyncio.to_thread(self._build_services)

        transport = SmallWebRTCTransport(
            webrtc_connection=self.connection,
            params=TransportParams(
                audio_in_enabled=True,
                audio_out_enabled=True,
                audio_in_sample_rate=16000,
                audio_out_sample_rate=TTS_SAMPLE_RATE,
            ),
        )
        talker = AcpTalkerProcessor(talker=self.talker, log=self.log, cues=self.cues, cfg=cfg, publish=self.publish)
        self.processor = talker
        stop = EndOfTurnStop(turn_analyzer=LocalSmartTurnAnalyzerV3(), log=self.log, on_eot=talker.on_end_of_turn)
        user_agg = LLMUserAggregator(
            LLMContext(),
            params=LLMUserAggregatorParams(
                vad_analyzer=SileroVADAnalyzer(params=VADParams(stop_secs=cfg.vad_stop_secs)),
                user_turn_strategies=UserTurnStrategies(stop=[stop]),
                empty_user_turn=None,
            ),
        )
        pipeline = Pipeline(
            [transport.input(), stt, user_agg, talker, tts, transport.output(), OutputTap(log=self.log)]
        )
        self.task = PipelineTask(
            pipeline,
            params=PipelineParams(enable_metrics=True, audio_in_sample_rate=16000, audio_out_sample_rate=TTS_SAMPLE_RATE),
            enable_rtvi=False,
            idle_timeout_secs=None,
        )

        @transport.event_handler("on_client_connected")
        async def _connected(_t, _c):
            logger.info(f"call {self.id}: client connected")
            self.publish({"type": "status", "text": "connected", "call": self.id, "backend": self.backend})
            await talker.start_event_loop()

        @transport.event_handler("on_client_disconnected")
        async def _disconnected(_t, _c):
            logger.info(f"call {self.id}: client disconnected")
            await self.task.cancel()

        try:
            await PipelineRunner(handle_sigint=False).run(self.task)
        finally:
            self.log.flush()
            await self.talker.close()
            self.publish({"type": "status", "text": "ended", "call": self.id})
            logger.info(f"call {self.id} ended; log {self.log.path}")

"""ACP client for the conversational "talker": one long-lived claude-agent-acp session.

Independent of Pipecat so it can be tested on its own. `AcpTalker.prompt()` yields a stream
of `TalkerEvent`s for one turn; `cancel()` sends `session/cancel` (barge-in).
Settings follow spikes/acp-latency/FINDINGS.md: Haiku, persona appended to the Claude Code
preset, ENABLE_TOOL_SEARCH=false, voice MCP tools pre-allowed.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import time
from contextlib import AsyncExitStack
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, AsyncIterator

from acp import PROTOCOL_VERSION, text_block
from acp.schema import (
    AgentMessageChunk,
    AllowedOutcome,
    ClientCapabilities,
    DeniedOutcome,
    EnvVariable,
    FileSystemCapabilities,
    Implementation,
    McpServerStdio,
    RequestPermissionResponse,
    ToolCallProgress,
    ToolCallStart,
    UsageUpdate,
)
from acp.stdio import spawn_agent_process
from loguru import logger

ROOT = Path(__file__).resolve().parent.parent
AGENT_DIR = ROOT / "agent"
ADAPTER_JS = AGENT_DIR / "node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js"
MCP_SERVER_TS = AGENT_DIR / "mcp-server.ts"

PERSONA = """You are Vibe, a voice assistant on a live phone call with a software developer.
You manage their coding agents through the "voice" MCP tools: list_sessions (what the agents are doing) and dispatch_task (send an agent an instruction; returns immediately).
Everything you write is converted to speech:
- Reply in 1 to 3 short spoken sentences. Plain conversational English. No markdown, lists, headings, code or emoji.
- Before calling a tool, always first say one brief sentence such as "Let me check." or "On it."
- Use only the voice tools. Never read files, run commands or browse.
- Do not ask for confirmation for simple dispatches; just do it and confirm briefly.
- The user's words come from speech recognition and may contain small errors; guess the intent.
- A message starting with [event] is a notification from one of the agents, not something the user said. Tell the user about it in one short sentence."""

VOICE_TOOLS = ["mcp__voice__list_sessions", "mcp__voice__dispatch_task"]


def now_ms() -> float:
    return time.time() * 1000.0


@dataclass
class TalkerEvent:
    kind: str  # "usage" | "text" | "tool_start" | "tool_end" | "done" | "error"
    t: float = field(default_factory=now_ms)
    text: str = ""
    tool_id: str = ""
    title: str = ""
    stop_reason: str = ""


class _Client:
    """ACP client side: routes session updates to the active turn, auto-approves tools."""

    def __init__(self, talker: "AcpTalker"):
        self._talker = talker

    def on_connect(self, conn) -> None:  # noqa: D401 - protocol hook
        pass

    async def request_permission(self, options, session_id, tool_call, **kwargs):
        # Voice tools are pre-allowed, so this only fires for unexpected tools: allow once.
        opt = next((o for o in options if o.kind == "allow_once"), None)
        logger.warning(f"ACP permission request for {getattr(tool_call, 'title', '?')} -> {opt and opt.kind}")
        if opt is None:
            return RequestPermissionResponse(outcome=DeniedOutcome(outcome="cancelled"))
        return RequestPermissionResponse(outcome=AllowedOutcome(outcome="selected", option_id=opt.option_id))

    async def session_update(self, session_id, update, **kwargs):
        self._talker._on_update(update)

    async def ext_method(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        return {}

    async def ext_notification(self, method: str, params: dict[str, Any]) -> None:
        pass


class AcpTalker:
    def __init__(
        self,
        *,
        model: str = os.environ.get("TALKER_MODEL", "haiku"),
        persona: str = PERSONA,
        workdir: Path | None = None,
        tool_log: Path | None = None,
    ):
        self.model = model
        self.persona = persona
        self.workdir = workdir or ROOT / "scratch" / "acp-session"
        self.tool_log = tool_log
        self._stack = AsyncExitStack()
        self._conn = None
        self._proc = None
        self.session_id: str | None = None
        self._queue: asyncio.Queue[TalkerEvent] | None = None
        self.ready_ms: dict[str, float] = {}

    async def start(self) -> None:
        self.workdir.mkdir(parents=True, exist_ok=True)
        node = shutil.which("node") or "node"
        bun = shutil.which("bun") or str(Path.home() / ".bun/bin/bun")
        t0 = now_ms()
        self._conn, self._proc = await self._stack.enter_async_context(
            spawn_agent_process(
                lambda _agent: _Client(self),
                node,
                str(ADAPTER_JS),
                env={**os.environ},
                cwd=str(self.workdir),
                transport_kwargs={"limit": 16 * 1024 * 1024},
            )
        )
        await self._conn.initialize(
            protocol_version=PROTOCOL_VERSION,
            client_capabilities=ClientCapabilities(
                fs=FileSystemCapabilities(read_text_file=False, write_text_file=False), terminal=False
            ),
            client_info=Implementation(name="voice-loop", version="0.1.0"),
        )
        t_init = now_ms()
        env = [EnvVariable(name="TOOL_LOG", value=str(self.tool_log))] if self.tool_log else []
        session = await self._conn.new_session(
            cwd=str(self.workdir),
            mcp_servers=[McpServerStdio(name="voice", command=bun, args=[str(MCP_SERVER_TS)], env=env)],
            systemPrompt={"append": self.persona},
            claudeCode={
                "options": {
                    "model": self.model,
                    "env": {"ENABLE_TOOL_SEARCH": "false"},
                    "allowedTools": VOICE_TOOLS,
                }
            },
        )
        self.session_id = session.session_id
        t_ready = now_ms()
        self.ready_ms = {"spawn_to_init": t_init - t0, "init_to_session": t_ready - t_init}
        logger.info(f"ACP session {self.session_id} ready in {t_ready - t0:.0f} ms ({self.model})")

    async def close(self) -> None:
        try:
            await self._stack.aclose()
        except Exception as e:  # the adapter may already be gone
            logger.debug(f"ACP close: {e}")
        if self._proc and self._proc.returncode is None:
            self._proc.kill()

    def _on_update(self, update) -> None:
        q = self._queue
        if q is None:
            return  # stray update outside a turn (e.g. after cancel)
        if isinstance(update, AgentMessageChunk):
            c = update.content
            if getattr(c, "type", None) == "text" and c.text:
                q.put_nowait(TalkerEvent("text", text=c.text))
        elif isinstance(update, ToolCallStart):
            q.put_nowait(TalkerEvent("tool_start", tool_id=update.tool_call_id, title=update.title or ""))
        elif isinstance(update, ToolCallProgress):
            if update.status in ("completed", "failed"):
                q.put_nowait(
                    TalkerEvent("tool_end", tool_id=update.tool_call_id, title=update.title or "", text=update.status)
                )
        elif isinstance(update, UsageUpdate):
            q.put_nowait(TalkerEvent("usage"))

    async def prompt(self, text: str) -> AsyncIterator[TalkerEvent]:
        """Run one turn. Yields events until a final "done" (or "error") event."""
        assert self._conn and self.session_id
        q: asyncio.Queue[TalkerEvent] = asyncio.Queue()
        self._queue = q

        async def run():
            try:
                res = await self._conn.prompt(session_id=self.session_id, prompt=[text_block(text)])
                q.put_nowait(TalkerEvent("done", stop_reason=str(res.stop_reason)))
            except asyncio.CancelledError:
                q.put_nowait(TalkerEvent("done", stop_reason="abandoned"))
                raise
            except Exception as e:
                q.put_nowait(TalkerEvent("error", text=str(e)))

        task = asyncio.create_task(run())
        try:
            while True:
                ev = await q.get()
                yield ev
                if ev.kind in ("done", "error"):
                    break
        finally:
            if self._queue is q:
                self._queue = None
            if not task.done():
                task.cancel()

    async def warmup(self) -> float:
        """Pay the cache-cold first turn off-line (not spoken). Returns its duration in ms."""
        t0 = now_ms()
        async for _ in self.prompt(
            "[system] Connection check before the call starts; this is not the user. Reply with one word: ready."
        ):
            pass
        self.ready_ms["warmup"] = now_ms() - t0
        return self.ready_ms["warmup"]

    async def cancel(self) -> None:
        if self._conn and self.session_id:
            await self._conn.cancel(session_id=self.session_id)


async def _smoke() -> None:
    talker = AcpTalker()
    await talker.start()
    try:
        for text in ["Hey, are you there?", "What are my agents doing right now?"]:
            t0 = now_ms()
            out = []
            async for ev in talker.prompt(text):
                out.append(f"{ev.t - t0:6.0f} {ev.kind} {ev.text or ev.title}")
            print(f"--- {text}\n" + "\n".join(out))
    finally:
        await talker.close()


if __name__ == "__main__":
    asyncio.run(_smoke())

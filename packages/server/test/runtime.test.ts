import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adapters } from "../src/acp/adapters/index.ts";
import { noMcp } from "../src/acp/mcp.ts";
import { probeHarness } from "../src/acp/probe.ts";
import { AgentRuntime, type RuntimeEvent, type RuntimeOptions } from "../src/acp/runtime.ts";

const FAKE_AGENT = join(import.meta.dir, "fake-agent.ts");

const runtimes: AgentRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((r) => r.dispose()));
});

function makeRuntime(overrides: Partial<RuntimeOptions> & { env?: Record<string, string> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "vc-runtime-"));
  const events: RuntimeEvent[] = [];
  const rt = new AgentRuntime({
    agent: {
      agentId: "a1",
      cwd: dir,
      systemPrompt: "You are Testy.",
      model: null,
      stateDir: join(dir, ".state"),
    },
    options: {},
    harness: { kind: "custom", command: process.execPath, args: [FAKE_AGENT], env: overrides.env ?? {} },
    adapter: adapters.custom,
    mcp: noMcp,
    session: { key: "s1", acpSessionId: null },
    onEvent: (e) => events.push(e),
    ...overrides,
  });
  runtimes.push(rt);
  const text = (turnId: string) =>
    events
      .filter(
        (e): e is Extract<RuntimeEvent, { type: "turn.update" }> =>
          e.type === "turn.update" && e.turnId === turnId,
      )
      .map((e) =>
        e.update.sessionUpdate === "agent_message_chunk" && e.update.content.type === "text"
          ? e.update.content.text
          : "",
      )
      .join("");
  return { rt, events, text, dir };
}

const textPrompt = (turnId: string, text: string, extra: object = {}) => ({
  turnId,
  content: [{ type: "text" as const, text }],
  ...extra,
});

describe("AgentRuntime against the fake ACP agent", () => {
  test("streams a reply and reports presence", async () => {
    const { rt, events, text } = makeRuntime();
    const result = await rt.prompt(textPrompt("t1", "hello there")).done;
    expect(result).toEqual({ status: "complete", stopReason: "end_turn", error: null });
    expect(text("t1")).toBe("Echo: hello there");
    const presences = events
      .filter((e) => e.type === "presence")
      .map((e) => (e as { presence: string }).presence);
    expect(presences).toEqual(["thinking", "idle"]);
    expect(events.find((e) => e.type === "session.ready")).toMatchObject({
      resumed: false,
      sessionKey: "s1",
    });
  });

  test("passes the system prompt via the spec field and applies model and options", async () => {
    const { rt, text } = makeRuntime({
      agent: {
        agentId: "a1",
        cwd: mkdtempSync(join(tmpdir(), "vc-")),
        systemPrompt: "You are Testy.",
        model: "fake-smart",
        stateDir: mkdtempSync(join(tmpdir(), "vc-state-")),
      },
      options: { mode: "yolo", nonexistent: "x" },
    });
    await rt.prompt(textPrompt("t1", "whoami", { note: "[voice mode]" })).done;
    expect(text("t1")).toContain("SYSTEM=[You are Testy.]");
    expect(text("t1")).toContain("MODEL=[fake-smart]");
    expect(text("t1")).toContain("MODE=[yolo]");
    expect(text("t1")).toContain("PROMPT=[[voice mode]\nwhoami]");
  });

  test("falls back to a first-prompt preamble without the systemPrompt capability", async () => {
    const { rt, text } = makeRuntime({ env: { FAKE_ACP_NO_SYSTEM_PROMPT: "1" } });
    await rt.prompt(textPrompt("t1", "whoami")).done;
    expect(text("t1")).toContain("SYSTEM=[]");
    expect(text("t1")).toContain("<system-instructions>\nYou are Testy.\n</system-instructions>");
    await rt.prompt(textPrompt("t2", "whoami")).done;
    expect(text("t2")).not.toContain("system-instructions");
  });

  test("cancel stops a streaming turn quickly", async () => {
    const { rt, text } = makeRuntime();
    const turn = rt.prompt(textPrompt("t1", "slow please"));
    await Bun.sleep(400);
    const t0 = Date.now();
    await rt.cancel();
    const result = await turn.done;
    expect(result.status).toBe("cancelled");
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(text("t1")).toContain("chunk 0.");
    expect(text("t1")).not.toContain("chunk 39.");
    // the session still works afterwards
    expect((await rt.prompt(textPrompt("t2", "again")).done).status).toBe("complete");
  });

  test("tool calls report working presence", async () => {
    const { rt, events } = makeRuntime();
    await rt.prompt(textPrompt("t1", "use a tool")).done;
    const working = events.find((e) => e.type === "presence" && e.presence === "working");
    expect(working).toMatchObject({ detail: "Read README.md" });
    const kinds = events
      .filter((e) => e.type === "turn.update")
      .map((e) => (e as { update: { sessionUpdate: string } }).update.sessionUpdate);
    expect(kinds).toContain("tool_call");
    expect(kinds).toContain("tool_call_update");
  });

  test("permission requests wait for an answer", async () => {
    const { rt, events, text } = makeRuntime();
    const turn = rt.prompt(textPrompt("t1", "needs permission"));
    let req: Extract<RuntimeEvent, { type: "permission.request" }> | undefined;
    for (let i = 0; i < 100 && !req; i++) {
      await Bun.sleep(20);
      req = events.find((e) => e.type === "permission.request") as typeof req;
    }
    expect(req).toBeDefined();
    expect(rt.presence.presence).toBe("waiting");
    expect(rt.respondPermission(req!.requestId, "allow")).toBe(true);
    expect((await turn.done).status).toBe("complete");
    expect(text("t1")).toContain("Permission granted");
    expect(events.find((e) => e.type === "permission.resolved")).toMatchObject({
      outcome: { optionId: "allow" },
    });
  });

  test("cancel answers a pending permission request with cancelled", async () => {
    const { rt, events } = makeRuntime();
    const turn = rt.prompt(textPrompt("t1", "needs permission"));
    for (let i = 0; i < 100 && !events.some((e) => e.type === "permission.request"); i++) await Bun.sleep(20);
    await rt.cancel();
    expect((await turn.done).status).toBe("cancelled");
    expect(events.find((e) => e.type === "permission.resolved")).toMatchObject({ outcome: "cancelled" });
  });

  test("idle timeout cancels a hung harness and restarts it, resuming the session", async () => {
    const state = join(mkdtempSync(join(tmpdir(), "vc-state-")), "sessions.json");
    const { rt, events, text } = makeRuntime({
      env: { FAKE_ACP_STATE: state },
      timeouts: { idleMs: 300, cancelGraceMs: 300 },
    });
    await rt.prompt(textPrompt("t0", "first")).done;
    const pid = rt.pid;
    const result = await rt.prompt(textPrompt("t1", "hang forever")).done;
    expect(result.status).toBe("error");
    expect(result.error).toContain("No response from the harness");
    const next = await rt.prompt(textPrompt("t2", "history")).done;
    expect(next.status).toBe("complete");
    expect(rt.pid).not.toBe(pid);
    expect(text("t2")).toContain("seen 3 prompts");
    const readies = events.filter((e) => e.type === "session.ready");
    expect(readies.at(-1)).toMatchObject({ resumed: true });
  });

  test("a crash ends the turn with an error and the next prompt respawns", async () => {
    const { rt } = makeRuntime();
    const result = await rt.prompt(textPrompt("t1", "crash now")).done;
    expect(result.status).toBe("error");
    expect(result.error).toContain("harness exited (code 3");
    expect(rt.presence.presence).toBe("error");
    expect((await rt.prompt(textPrompt("t2", "still there?")).done).status).toBe("complete");
    expect(rt.presence.presence).toBe("idle");
  });

  test("a session that can't be resumed is replaced and reported", async () => {
    const { rt, events } = makeRuntime({ session: { key: "s1", acpSessionId: "fake-does-not-exist" } });
    expect((await rt.prompt(textPrompt("t1", "hi")).done).status).toBe("complete");
    expect(events.find((e) => e.type === "session.ready")).toMatchObject({
      resumed: false,
      resumeFailed: expect.stringContaining("unknown session"),
    });
  });

  test("queued prompts run in order; cancel drops the queue", async () => {
    const { rt, events } = makeRuntime();
    const a = rt.prompt(textPrompt("a", "slow"));
    const b = rt.prompt(textPrompt("b", "second"));
    await Bun.sleep(300);
    await rt.cancel();
    expect((await a.done).status).toBe("cancelled");
    expect((await b.done).status).toBe("cancelled");
    expect(
      events.filter((e) => e.type === "turn.start").map((e) => (e as { turnId: string }).turnId),
    ).toEqual(["a"]);
    const c = await rt.prompt(textPrompt("c", "third")).done;
    expect(c.status).toBe("complete");
  });

  test("cancelPrompt cancels one turn and leaves the others", async () => {
    const { rt } = makeRuntime();
    const a = rt.prompt(textPrompt("a", "slow"));
    const b = rt.prompt(textPrompt("b", "queued"));
    const c = rt.prompt(textPrompt("c", "slow too"));
    await Bun.sleep(300);
    rt.cancelPrompt("b"); // queued: dropped
    rt.cancelPrompt("a"); // running: session/cancel
    expect((await a.done).status).toBe("cancelled");
    expect((await b.done).status).toBe("cancelled");
    await Bun.sleep(200);
    rt.cancelPrompt("c");
    expect((await c.done).status).toBe("cancelled");
    expect((await rt.prompt(textPrompt("d", "after")).done).status).toBe("complete");
  });

  test("newSession starts a fresh ACP session", async () => {
    const { rt, events, text } = makeRuntime();
    await rt.prompt(textPrompt("t1", "one")).done;
    await rt.newSession("s2");
    await rt.prompt(textPrompt("t2", "history")).done;
    expect(text("t2")).toContain("seen 1 prompts");
    const readies = events.filter((e) => e.type === "session.ready");
    expect(readies.map((e) => (e as { sessionKey: string }).sessionKey)).toEqual(["s1", "s2"]);
  });

  test("a missing working directory fails the turn with a clear error", async () => {
    const { rt } = makeRuntime({
      agent: { agentId: "a1", cwd: "/nonexistent/dir", systemPrompt: "", model: null, stateDir: "/tmp/vc-x" },
    });
    const result = await rt.prompt(textPrompt("t1", "hi")).done;
    expect(result).toMatchObject({
      status: "error",
      error: expect.stringContaining("working directory does not exist"),
    });
  });
});

describe("probeHarness", () => {
  test("reads capabilities and config options", async () => {
    const { health, probe } = await probeHarness({
      kind: "custom",
      command: process.execPath,
      args: [FAKE_AGENT],
      env: {},
    });
    expect(health.status).toBe("ok");
    expect(probe?.agentName).toBe("Fake Agent");
    expect(probe?.capabilities).toMatchObject({ resumeSession: true, systemPrompt: true });
    expect(probe?.configOptions.find((o) => o.id === "model")).toMatchObject({
      type: "select",
      options: [
        expect.objectContaining({ value: "fake-fast" }),
        expect.objectContaining({ value: "fake-smart" }),
      ],
    });
  });

  test("deep probe sends a test prompt", async () => {
    const { health } = await probeHarness(
      { kind: "custom", command: process.execPath, args: [FAKE_AGENT], env: {} },
      { deep: true },
    );
    expect(health).toMatchObject({ status: "ok", message: expect.stringContaining("Echo") });
  });

  test("reports a missing command as not installed", async () => {
    const { health } = await probeHarness({
      kind: "custom",
      command: "definitely-not-a-command-xyz",
      args: [],
      env: {},
    });
    expect(health.status).toBe("not_installed");
  });
});

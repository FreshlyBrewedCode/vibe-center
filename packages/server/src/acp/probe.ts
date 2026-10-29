import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessHealth, HarnessProbe } from "@vibe-center/shared";
import { type AuthReport, adapters, type HarnessLaunchConfig, launchSpec } from "./adapters/index.ts";
import { toConfigOptions } from "./config-options.ts";
import { AcpProcess, raceExit, SpawnError, withTimeout } from "./process.ts";
import type * as acp from "./protocol.ts";
import { describeError } from "./runtime.ts";

export interface ProbeResult {
  health: HarnessHealth;
  probe: HarnessProbe | null;
}

/**
 * Start the harness in a scratch directory, `initialize`, open a session and read what it offers
 * (models and other config options), then stop it. With `deep`, also send a one-word prompt to
 * prove the model behind it answers (costs a request). Never throws.
 */
export async function probeHarness(
  harness: HarnessLaunchConfig,
  opts: { deep?: boolean; timeoutMs?: number } = {},
): Promise<ProbeResult> {
  const adapter = adapters[harness.kind];
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const dir = await mkdtemp(join(tmpdir(), "vibe-center-probe-"));
  const now = Date.now();
  const health = (status: HarnessHealth["status"], message: string | null): HarnessHealth => ({
    status,
    message,
    checkedAt: now,
  });
  let auth: AuthReport | null = null;
  let proc: AcpProcess | null = null;
  let replyText = "";
  try {
    const agent = { agentId: "probe", cwd: dir, systemPrompt: "", model: null, stateDir: dir };
    const { env } = await adapter.prepareProcess(agent);
    proc = await AcpProcess.start(
      launchSpec(harness, dir, env),
      {
        onUpdate: (n) => {
          const u = n.update;
          if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text")
            replyText += u.content.text;
        },
        onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        onOtherNotification: (method, params) => {
          auth = adapter.readAuth?.(method, params) ?? auth;
        },
      },
      { initTimeoutMs: timeoutMs, clientName: "vibe-center-probe" },
    );
    const p = proc;
    const caps = p.init.agentCapabilities ?? {};
    const newSession: acp.NewSessionRequest = {
      cwd: dir,
      mcpServers: [],
      ...adapter.sessionFields({ ...agent, capabilities: caps, mcp: { servers: [], allowedTools: [] } }),
    };
    const session = await raceExit(
      withTimeout(p.agent.request("session/new", newSession), timeoutMs, "session/new timed out"),
      p.exited,
      () => p.stderrTail(10),
    );
    const probe: HarnessProbe = {
      agentName: p.init.agentInfo?.title ?? p.init.agentInfo?.name ?? null,
      agentVersion: p.init.agentInfo?.version ?? null,
      capabilities: {
        loadSession: !!caps.loadSession,
        resumeSession: !!caps.sessionCapabilities?.resume,
        systemPrompt: !!caps.sessionCapabilities?.systemPrompt,
        mcpHttp: !!caps.mcpCapabilities?.http,
        image: !!caps.promptCapabilities?.image,
      },
      configOptions: toConfigOptions(session.configOptions),
      probedAt: now,
    };
    if (adapter.readAuth && !auth) await waitFor(() => auth !== null, 3000);
    const authReport = auth as AuthReport | null;
    if (authReport && !authReport.loggedIn) {
      return {
        health: health("auth_required", `${authReport.label}. Log in with the harness's CLI.`),
        probe,
      };
    }
    const who = authReport ? ` (${authReport.label})` : "";
    if (opts.deep) {
      const res = await raceExit(
        withTimeout(
          p.agent.request("session/prompt", {
            sessionId: session.sessionId,
            prompt: [{ type: "text", text: "Reply with the single word OK." }],
          }),
          timeoutMs,
          "test prompt timed out",
        ),
        p.exited,
        () => p.stderrTail(10),
      );
      if (!replyText.trim()) {
        return { health: health("error", `test prompt ended (${res.stopReason}) without a reply`), probe };
      }
      return {
        health: health("ok", `test prompt answered: "${replyText.trim().slice(0, 40)}"${who}`),
        probe,
      };
    }
    return {
      health: health("ok", `${probe.agentName ?? "agent"} ${probe.agentVersion ?? ""}${who}`.trim()),
      probe,
    };
  } catch (e) {
    if (e instanceof SpawnError && e.notInstalled)
      return { health: health("not_installed", e.message), probe: null };
    const message = describeError(e);
    const status = /auth|log ?in|api key|credential/i.test(message) ? "auth_required" : "error";
    return { health: health(status, message), probe: null };
  } finally {
    await proc?.close(1000);
    await rm(dir, { recursive: true, force: true });
  }
}

async function waitFor(cond: () => boolean, ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (!cond() && Date.now() < until) await Bun.sleep(50);
}

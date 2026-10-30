import type { McpProvider } from "./acp/mcp.ts";
import type { RuntimeTimeouts } from "./acp/runtime.ts";
import { AuthService } from "./auth/auth.ts";
import { dataPaths, ensureDataDir } from "./config.ts";
import { openDb } from "./db/index.ts";
import { createRepos, type Repos } from "./db/repos/index.ts";
import { AgentService } from "./domain/agents.ts";
import { ChatService } from "./domain/chat.ts";
import { HarnessService } from "./domain/harnesses.ts";
import { PresenceStore } from "./domain/presence.ts";
import { WatchService } from "./domain/watches.ts";
import { EventBus } from "./events/bus.ts";
import { resultText } from "./mcp/gateway.ts";
import { McpService } from "./mcp/service.ts";
import { ProcessRegistry } from "./procs.ts";
import { type VoiceOptions, VoiceService } from "./voice/service.ts";

export interface ServicesOptions {
  dataDir: string;
  /** SEAM (phase 2a): the MCP provider for ACP sessions. Defaults to the app's MCP gateway. */
  mcp?: McpProvider;
  timeouts?: Partial<RuntimeTimeouts>;
  voice?: VoiceOptions;
}

/** The app's domain services, wired together. HTTP, WS and the CLI only talk to these. */
export interface Services {
  dataDir: string;
  repos: Repos;
  bus: EventBus;
  presence: PresenceStore;
  auth: AuthService;
  harnesses: HarnessService;
  chat: ChatService;
  agents: AgentService;
  /** MCP servers, per-agent tools, memories and the gateway (phase 2a). */
  mcp: McpService;
  /** The tailnet HTTPS URL `tailscale serve` published, if any. Set once up by the CLI. */
  publicUrl: string | null;
  setPublicUrl(url: string | null): void;
  /** Voice calls: the worker, its bridge and the calls (phase 2b). */
  voice: VoiceService;
  /** Background waits: watches agents register, and the inbox that turns firings into turns. */
  watches: WatchService;
  /** Process groups the server spawned (harnesses, voice worker, GPU jobs), for crash reaping. */
  procs: ProcessRegistry;
  close(): Promise<void>;
}

export function createServices(opts: ServicesOptions): Services {
  ensureDataDir(opts.dataDir);
  // whatever a crashed earlier run left running goes before anything new starts
  const procs = new ProcessRegistry(dataPaths(opts.dataDir).run);
  procs.reapStale();
  const repos = createRepos(openDb(dataPaths(opts.dataDir).db));
  const bus = new EventBus();
  const presence = new PresenceStore(bus);
  const auth = new AuthService(repos, bus);
  const harnesses = new HarnessService(repos, bus, procs);
  const mcp = new McpService(repos, bus);
  const chat = new ChatService(repos, bus, presence, harnesses, {
    dataDir: opts.dataDir,
    mcp: opts.mcp ?? mcp.gateway,
    timeouts: opts.timeouts,
    tracker: procs,
  });
  const agents = new AgentService(repos, bus, presence, harnesses, chat, {
    beforeDelete: (agentId) => voice.hangUpAgent(agentId, "the agent was deleted"),
  });
  const voice = new VoiceService(
    { repos, bus, chat, presence, dataDir: opts.dataDir, tracker: procs },
    opts.voice,
  );
  const speakEvent = (agentId: string, text: string, o: Parameters<VoiceService["speakEvent"]>[2]) =>
    voice.speakEvent(agentId, text, o);
  // fired watches (incl. agent replies) go into a call with the agent when there is one
  const watches = new WatchService({
    repos,
    bus,
    chat,
    speakEvent,
    tools: {
      resolve(agentId, name) {
        const tool = mcp.gateway.resolveUpstream(agentId, name);
        return {
          label: tool.exposedName,
          run: async (args, o) => {
            const r = await mcp.gateway.callInBackground(agentId, tool, args, o);
            return { text: resultText(r), isError: !!r.isError };
          },
        };
      },
    },
  });
  mcp.bind({ chat, presence, speakEvent, watches });
  const services: Services = {
    dataDir: opts.dataDir,
    repos,
    bus,
    presence,
    auth,
    harnesses,
    chat,
    agents,
    mcp,
    publicUrl: null,
    setPublicUrl(url) {
      services.publicUrl = url;
      voice.setPublicUrl(url);
      watches.setUrls({ public: url });
    },
    voice,
    watches,
    procs,
    async close() {
      watches.stop();
      await voice.stop();
      await chat.dispose();
      await mcp.close();
      repos.db.close();
    },
  };
  return services;
}

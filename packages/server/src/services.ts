import type { McpProvider } from "./acp/mcp.ts";
import type { RuntimeTimeouts } from "./acp/runtime.ts";
import { AuthService } from "./auth/auth.ts";
import { dataPaths } from "./config.ts";
import { openDb } from "./db/index.ts";
import { createRepos, type Repos } from "./db/repos/index.ts";
import { AgentService } from "./domain/agents.ts";
import { ChatService } from "./domain/chat.ts";
import { HarnessService } from "./domain/harnesses.ts";
import { PresenceStore } from "./domain/presence.ts";
import { EventBus } from "./events/bus.ts";
import { McpService } from "./mcp/service.ts";
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
  close(): Promise<void>;
}

export function createServices(opts: ServicesOptions): Services {
  const repos = createRepos(openDb(dataPaths(opts.dataDir).db));
  const bus = new EventBus();
  const presence = new PresenceStore(bus);
  const auth = new AuthService(repos, bus);
  const harnesses = new HarnessService(repos, bus);
  const mcp = new McpService(repos, bus);
  const chat = new ChatService(repos, bus, presence, harnesses, {
    dataDir: opts.dataDir,
    mcp: opts.mcp ?? mcp.gateway,
    timeouts: opts.timeouts,
  });
  const agents = new AgentService(repos, bus, presence, harnesses, chat);
  const voice = new VoiceService({ repos, bus, chat, presence, dataDir: opts.dataDir }, opts.voice);
  // agent replies to an agent in a call are spoken there (2a's messenger → 2b's event hook)
  mcp.bind({ chat, presence, speakEvent: (agentId, text, o) => voice.speakEvent(agentId, text, o) });
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
    },
    voice,
    async close() {
      await voice.stop();
      await chat.dispose();
      await mcp.close();
      repos.db.close();
    },
  };
  return services;
}

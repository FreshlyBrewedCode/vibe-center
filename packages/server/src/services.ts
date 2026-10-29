import type { McpProvider } from "./acp/mcp.ts";
import { noMcp } from "./acp/mcp.ts";
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

export interface ServicesOptions {
  dataDir: string;
  /** SEAM (phase 2a): the MCP gateway's provider. Defaults to no MCP servers. */
  mcp?: McpProvider;
  timeouts?: Partial<RuntimeTimeouts>;
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
  close(): Promise<void>;
}

export function createServices(opts: ServicesOptions): Services {
  const repos = createRepos(openDb(dataPaths(opts.dataDir).db));
  const bus = new EventBus();
  const presence = new PresenceStore(bus);
  const auth = new AuthService(repos, bus);
  const harnesses = new HarnessService(repos, bus);
  const chat = new ChatService(repos, bus, presence, harnesses, {
    dataDir: opts.dataDir,
    mcp: opts.mcp ?? noMcp,
    timeouts: opts.timeouts,
  });
  const agents = new AgentService(repos, bus, presence, harnesses, chat);
  return {
    dataDir: opts.dataDir,
    repos,
    bus,
    presence,
    auth,
    harnesses,
    chat,
    agents,
    async close() {
      await chat.dispose();
      repos.db.close();
    },
  };
}

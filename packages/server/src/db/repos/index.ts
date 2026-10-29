import type { Db } from "../index.ts";
import { AgentRepo } from "./agents.ts";
import { ConversationRepo } from "./conversations.ts";
import { DeviceRepo } from "./devices.ts";
import { HarnessRepo } from "./harnesses.ts";
import { MessageRepo } from "./messages.ts";

export type Repos = ReturnType<typeof createRepos>;

export function createRepos(db: Db) {
  return {
    db,
    agents: new AgentRepo(db),
    harnesses: new HarnessRepo(db),
    conversations: new ConversationRepo(db),
    messages: new MessageRepo(db),
    devices: new DeviceRepo(db),
  };
}

// Background waits contract: an agent's watches (registered through its built-in tools) and
// cancelling one from the UI. Webhook watches are triggered at `watchPaths.hook`.
import type { Watch } from "./domain.ts";

export const watchPaths = {
  /** GET: the agent's active watches plus the most recent ended ones (`WatchesResponse`). */
  agentWatches: (agentId: string) => `/api/agents/${agentId}/watches`,
  /** DELETE: cancel an active watch (→ the cancelled `Watch`). */
  watch: (id: string) => `/api/watches/${id}`,
  /** POST/PUT from anything that can reach the app (no cookie; the secret is in the path). */
  hookPrefix: "/hooks/w/",
  hook: (id: string, secret: string) => `/hooks/w/${id}/${secret}`,
} as const;

export type WatchesResponse = Watch[];

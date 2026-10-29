// Tab title: shows the total unread count across agents, so a backgrounded tab still signals
// that something needs attention.
import type { AgentView } from "@vibe-center/shared";
import { useEffect } from "react";

const BASE_TITLE = "Vibe Center";

export function useUnreadTitle(agents: AgentView[] | undefined): void {
  useEffect(() => {
    const total = agents?.reduce((n, a) => n + a.unread, 0) ?? 0;
    document.title = total > 0 ? `(${total}) ${BASE_TITLE}` : BASE_TITLE;
  }, [agents]);
}

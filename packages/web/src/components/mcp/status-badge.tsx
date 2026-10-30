import type { McpServerStatus } from "@vibe-center/shared";
import { Badge } from "@/components/ui/badge";

const labels: Record<McpServerStatus["state"], string> = {
  unknown: "Not connected",
  connecting: "Connecting…",
  connected: "Connected",
  error: "Error",
  disabled: "Disabled",
};

export function McpStatusBadge({ status }: { status: McpServerStatus }) {
  const variant =
    status.state === "connected"
      ? "ok"
      : status.state === "error"
        ? "destructive"
        : status.state === "connecting"
          ? "warn"
          : "outline";
  return (
    <Badge variant={variant} title={status.message ?? undefined} data-testid="mcp-status">
      {labels[status.state]}
    </Badge>
  );
}

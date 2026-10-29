import type { HarnessHealth } from "@vibe-center/shared";
import { Badge } from "@/components/ui/badge";

const labels: Record<HarnessHealth["status"], string> = {
  unknown: "Unknown",
  ok: "Working",
  not_installed: "Not installed",
  auth_required: "Login needed",
  error: "Error",
};

export function HealthBadge({ health }: { health: HarnessHealth }) {
  const variant =
    health.status === "ok" ? "secondary" : health.status === "unknown" ? "outline" : "destructive";
  return (
    <Badge variant={variant} title={health.message ?? undefined} data-testid="health">
      {health.message === "checking…" ? "Checking…" : labels[health.status]}
    </Badge>
  );
}

import { createFileRoute } from "@tanstack/react-router";
import { RefreshCw, Zap } from "lucide-react";
import { toast } from "sonner";
import { HealthBadge } from "@/components/health-badge";
import { Button } from "@/components/ui/button";
import { useHarnesses, useProbeHarness } from "@/lib/queries";
import { Section } from "../settings";

export const Route = createFileRoute("/_app/settings/harnesses")({ component: Harnesses });

function Harnesses() {
  const harnesses = useHarnesses();
  const probe = useProbeHarness();
  const run = (id: string, deep: boolean) =>
    probe.mutate({ id, deep }, { onError: (e) => toast.error(e.message) });
  return (
    <Section title="Harnesses">
      <ul className="divide-y rounded-lg border">
        {harnesses.data?.map((h) => (
          <li key={h.id} data-testid={`harness-${h.id}`} className="space-y-1 p-3">
            <div className="flex items-center gap-2">
              <span className="font-medium text-sm">{h.name}</span>
              <HealthBadge health={h.health} />
              <span className="flex-1" />
              <Button size="sm" variant="ghost" onClick={() => run(h.id, false)} disabled={probe.isPending}>
                <RefreshCw className="size-3.5" /> Check
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => run(h.id, true)}
                disabled={probe.isPending}
                title="Sends a one-word test prompt (costs a request)"
              >
                <Zap className="size-3.5" /> Test prompt
              </Button>
            </div>
            <code className="block truncate text-muted-foreground text-xs">
              {h.resolvedCommand.join(" ") || "(no command)"}
            </code>
            {h.health.message && <p className="text-muted-foreground text-xs">{h.health.message}</p>}
            {h.probe && (
              <p className="text-muted-foreground text-xs">
                {h.probe.configOptions
                  .map((o) => (o.type === "select" ? `${o.name}: ${o.options.length}` : o.name))
                  .join(" · ") || "No config options"}
              </p>
            )}
          </li>
        ))}
      </ul>
    </Section>
  );
}

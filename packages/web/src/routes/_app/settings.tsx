import { createFileRoute } from "@tanstack/react-router";
import { RefreshCw, Zap } from "lucide-react";
import { toast } from "sonner";
import { HealthBadge } from "@/components/health-badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useDevices, useHarnesses, useProbeHarness, useRevokeDevice } from "@/lib/queries";
import { setTheme, type Theme, useTheme } from "@/lib/theme";

/** Minimal settings: harness health, devices, theme. Phase 2c builds the full settings UI. */
export const Route = createFileRoute("/_app/settings")({ component: Settings });

function Settings() {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-8 p-6">
        <h1 className="font-semibold text-xl">Settings</h1>
        <Harnesses />
        <Devices />
        <Appearance />
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="font-medium text-muted-foreground text-sm">{title}</h2>
      {children}
    </section>
  );
}

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

function Devices() {
  const devices = useDevices();
  const revoke = useRevokeDevice();
  return (
    <Section title="Devices">
      <ul className="divide-y rounded-lg border">
        {devices.data?.map((d) => (
          <li key={d.id} className="flex items-center gap-3 p-3 text-sm">
            <div className="min-w-0 flex-1">
              <div className="font-medium">
                {d.name} {d.current && <span className="text-muted-foreground text-xs">(this device)</span>}
              </div>
              <div className="text-muted-foreground text-xs">
                {d.revokedAt ? "Revoked" : `Last seen ${new Date(d.lastSeenAt).toLocaleString()}`}
              </div>
            </div>
            {!d.revokedAt && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  if (d.current && !confirm("Sign this device out?")) return;
                  revoke.mutate(d.id, { onError: (e) => toast.error(e.message) });
                }}
              >
                Revoke
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Section>
  );
}

function Appearance() {
  const theme = useTheme();
  return (
    <Section title="Appearance">
      <Select value={theme} onValueChange={(v) => setTheme(v as Theme)}>
        <SelectTrigger aria-label="Theme" className="w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="system">System</SelectItem>
          <SelectItem value="light">Light</SelectItem>
          <SelectItem value="dark">Dark</SelectItem>
        </SelectContent>
      </Select>
    </Section>
  );
}

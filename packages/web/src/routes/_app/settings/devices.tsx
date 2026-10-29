import { createFileRoute } from "@tanstack/react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useDevices, useRevokeDevice } from "@/lib/queries";
import { Section } from "../settings";

export const Route = createFileRoute("/_app/settings/devices")({ component: Devices });

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

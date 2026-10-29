import { createFileRoute } from "@tanstack/react-router";
import type { Device } from "@vibe-center/shared";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useDevices, useRevokeDevice } from "@/lib/queries";
import { Section } from "../settings";

export const Route = createFileRoute("/_app/settings/devices")({ component: Devices });

function Devices() {
  const devices = useDevices();
  return (
    <Section title="Devices">
      <ul className="divide-y rounded-lg border">
        {devices.data?.map((d) => (
          <li key={d.id} data-testid="device" className="flex items-center gap-3 p-3 text-sm">
            <div className="min-w-0 flex-1">
              <div className="font-medium">
                {d.name} {d.current && <span className="text-muted-foreground text-xs">(this device)</span>}
              </div>
              <div className="text-muted-foreground text-xs">
                {d.revokedAt ? "Revoked" : `Last seen ${new Date(d.lastSeenAt).toLocaleString()}`}
              </div>
            </div>
            {!d.revokedAt && <RevokeButton device={d} />}
          </li>
        ))}
      </ul>
    </Section>
  );
}

function RevokeButton({ device }: { device: Device }) {
  const revoke = useRevokeDevice();
  const doRevoke = () => revoke.mutate(device.id, { onError: (e) => toast.error(e.message) });

  if (!device.current) {
    return (
      <Button size="sm" variant="outline" onClick={doRevoke}>
        Revoke
      </Button>
    );
  }
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="outline">
          Revoke
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Sign this device out?</AlertDialogTitle>
          <AlertDialogDescription>
            This is the device you're using right now. You'll need a fresh sign-in link to come back.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={doRevoke}>Sign out</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

import { createFileRoute } from "@tanstack/react-router";
import type { Device } from "@vibe-center/shared";
import { Check, Pencil, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { AddDeviceDialog } from "@/components/add-device-dialog";
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
import { Input } from "@/components/ui/input";
import { useDevices, useRenameDevice, useRevokeDevice } from "@/lib/queries";
import { Section } from "../settings";

export const Route = createFileRoute("/_app/settings/devices")({ component: Devices });

function Devices() {
  const devices = useDevices();
  return (
    <Section title="Devices">
      <div className="flex justify-end">
        <AddDeviceDialog />
      </div>
      <ul className="divide-y rounded-lg border">
        {devices.data?.map((d) => (
          <li key={d.id} data-testid="device" className="flex items-center gap-3 p-3 text-sm">
            <DeviceName device={d} />
            {!d.revokedAt && <RevokeButton device={d} />}
          </li>
        ))}
      </ul>
    </Section>
  );
}

function DeviceName({ device }: { device: Device }) {
  const rename = useRenameDevice();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(device.name);

  if (editing) {
    return (
      <form
        className="flex min-w-0 flex-1 items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = name.trim();
          if (!trimmed || trimmed === device.name) {
            setEditing(false);
            return;
          }
          rename.mutate(
            { id: device.id, name: trimmed },
            { onError: (err) => toast.error(err.message), onSettled: () => setEditing(false) },
          );
        }}
      >
        <Input
          autoFocus
          aria-label="New device name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="h-7 text-sm"
          maxLength={100}
        />
        <Button type="submit" size="icon-xs" variant="ghost" aria-label="Save name">
          <Check className="size-3.5" />
        </Button>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Cancel"
          onClick={() => {
            setName(device.name);
            setEditing(false);
          }}
        >
          <X className="size-3.5" />
        </Button>
      </form>
    );
  }

  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-1 font-medium">
        <span className="truncate">{device.name}</span>
        {device.current && <span className="text-muted-foreground text-xs">(this device)</span>}
        <button
          type="button"
          aria-label="Rename device"
          className="text-muted-foreground hover:text-foreground"
          onClick={() => {
            // Re-sync in case another device renamed it since this component mounted.
            setName(device.name);
            setEditing(true);
          }}
        >
          <Pencil className="size-3" />
        </button>
      </div>
      <div className="text-muted-foreground text-xs">
        {device.revokedAt ? "Revoked" : `Last seen ${new Date(device.lastSeenAt).toLocaleString()}`}
      </div>
    </div>
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

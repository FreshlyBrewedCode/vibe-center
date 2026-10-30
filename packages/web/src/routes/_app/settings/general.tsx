import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import {
  notificationPermission,
  notificationsEnabled,
  notificationsSupported,
  requestNotificationPermission,
  setNotificationsEnabled,
} from "@/lib/notifications";
import { useInfo } from "@/lib/queries";
import { Card, Section } from "../settings";

export const Route = createFileRoute("/_app/settings/general")({ component: General });

function General() {
  const info = useInfo();
  return (
    <>
      <Section title="Server">
        <Card>
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2.5 p-4 text-sm">
            <dt className="text-muted-foreground">Version</dt>
            <dd>{info.data?.version ?? "…"}</dd>
            <dt className="text-muted-foreground">Data directory</dt>
            <dd className="truncate">
              <code className="font-mono text-xs">{info.data?.dataDir ?? "…"}</code>
            </dd>
            <dt className="text-muted-foreground">Server address</dt>
            <dd className="truncate">
              {info.data?.publicUrl ? (
                <a
                  className="underline decoration-line-strong underline-offset-2 hover:decoration-foreground"
                  href={info.data.publicUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {info.data.publicUrl}
                </a>
              ) : (
                <span className="text-muted-foreground">Local only (not published on the tailnet)</span>
              )}
            </dd>
          </dl>
        </Card>
      </Section>
      <Section title="Notifications">
        <NotificationsToggle />
      </Section>
    </>
  );
}

function NotificationsToggle() {
  const [enabled, setEnabled] = useState(notificationsEnabled());
  const [permission, setPermission] = useState(notificationPermission());

  useEffect(() => {
    setEnabled(notificationsEnabled());
  }, []);

  if (!notificationsSupported()) {
    return <p className="text-muted-foreground text-sm">Not supported in this browser.</p>;
  }

  return (
    <Card className="flex items-center justify-between gap-4 p-4">
      <div className="min-w-0">
        <p className="font-medium text-sm">Notify when an agent finishes or needs approval</p>
        <p className="mt-0.5 text-muted-foreground text-xs">
          Only while its DM isn't the one you're looking at.
        </p>
        {permission === "denied" && (
          <p className="mt-1.5 text-destructive text-xs">
            Blocked in your browser's site settings; allow notifications for this site to turn it on.
          </p>
        )}
      </div>
      <Switch
        aria-label="Notifications"
        checked={enabled}
        onCheckedChange={async (checked) => {
          if (!checked) {
            setNotificationsEnabled(false);
            setEnabled(false);
            return;
          }
          const perm = permission === "granted" ? permission : await requestNotificationPermission();
          setPermission(perm);
          if (perm !== "granted") {
            toast.error("Notification permission was not granted.");
            return;
          }
          setNotificationsEnabled(true);
          setEnabled(true);
        }}
      />
    </Card>
  );
}

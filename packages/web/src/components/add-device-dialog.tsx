import type { MintLinkResponse } from "@vibe-center/shared";
import { Copy, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import QRCode from "react-qr-code";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { subscribe } from "@/lib/events";
import { useCancelLink, useMintLink } from "@/lib/queries";

/**
 * Settings → Devices → "Add device": a QR code and copyable link for a fresh sign-in link, minted
 * from this device. Shows "Paired: <name>" live once the link is redeemed (`device.link.paired`).
 */
export function AddDeviceDialog() {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          Add device
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Add a device</DialogTitle>
          <DialogDescription>
            Scan this with the new device, or open the link there. Works once and expires in 10 minutes.
          </DialogDescription>
        </DialogHeader>
        {open && <AddDeviceBody />}
      </DialogContent>
    </Dialog>
  );
}

function AddDeviceBody() {
  const mint = useMintLink();
  const cancel = useCancelLink();
  const [label, setLabel] = useState("");
  const [link, setLink] = useState<MintLinkResponse | null>(null);
  const [paired, setPaired] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const linkRef = useRef<MintLinkResponse | null>(null);
  const pairedRef = useRef(false);
  linkRef.current = link;
  pairedRef.current = paired !== null;

  const generate = (l: string | undefined) => {
    const prev = linkRef.current;
    if (prev && !pairedRef.current) cancel.mutate(prev.id);
    setPaired(null);
    setLink(null);
    mint.mutate(l, { onSuccess: setLink, onError: (e) => toast.error(e.message) });
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: mint once per mount (dialog open)
  useEffect(() => {
    generate(undefined);
    // Cancel whatever link is still outstanding when the dialog closes.
    return () => {
      if (linkRef.current && !pairedRef.current) cancel.mutate(linkRef.current.id);
    };
  }, []);

  useEffect(() => {
    if (!link) return;
    return subscribe((e) => {
      if (e.type === "device.link.paired" && e.linkId === link.id) setPaired(e.device.name);
    });
  }, [link]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const secondsLeft = link ? Math.max(0, Math.round((link.expiresAt - now) / 1000)) : 0;
  const expired = !!link && secondsLeft <= 0 && !paired;

  return (
    <div className="space-y-4">
      {paired ? (
        <div className="rounded-lg border bg-muted/30 p-6 text-center">
          <div className="font-medium">Paired: {paired}</div>
          <p className="mt-1 text-muted-foreground text-sm">The new device is signed in.</p>
        </div>
      ) : link ? (
        <>
          {/* Fixed white, not a theme token: scanners need a light quiet zone around the code,
              in light or dark mode, matching the SVG's own black-on-white rendering. */}
          <div className="flex justify-center rounded-lg border bg-white p-4">
            <QRCode value={link.url} size={192} level="M" />
          </div>
          <div className="flex items-center gap-2">
            <Input
              readOnly
              aria-label="Sign-in link"
              value={link.url}
              className="font-mono text-xs"
              onFocus={(e) => e.currentTarget.select()}
            />
            <Button
              size="icon-sm"
              variant="outline"
              aria-label="Copy link"
              onClick={() => {
                void navigator.clipboard.writeText(link.url);
                toast.success("Link copied");
              }}
            >
              <Copy className="size-4" />
            </Button>
          </div>
          <p className="text-center text-muted-foreground text-xs">
            {expired ? "This link expired." : `Expires in ${formatCountdown(secondsLeft)}`}
          </p>
        </>
      ) : (
        <p className="py-8 text-center text-muted-foreground text-sm">
          {mint.isError ? "Couldn't generate a link." : "Generating…"}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Input
          aria-label="Device name"
          placeholder="Device name (optional)"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          disabled={!!paired}
          maxLength={100}
        />
        <Button variant="outline" onClick={() => generate(label || undefined)} disabled={!!paired}>
          <RotateCcw className="size-4" />
          Generate new
        </Button>
      </div>
    </div>
  );
}

function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

import { voicePaths } from "@vibe-center/shared";
import { Loader2, Play } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useVoiceStatus, useVoices } from "@/lib/queries";

const DEFAULT = "__default__";
const GROUPS: [prefix: string, label: string][] = [
  ["af", "American English, female"],
  ["am", "American English, male"],
  ["bf", "British English, female"],
  ["bm", "British English, male"],
];

/** `af_heart` → `Heart` */
const voiceName = (v: string) => v.replace(/^[a-z]{2}_/, "").replace(/^./, (c) => c.toUpperCase());

/** The agent's TTS voice for calls, from the TTS server's list, with a preview button. */
export function VoicePicker({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  const status = useVoiceStatus();
  const online = status.data?.worker.state === "ok";
  const voices = useVoices(online);
  const [playing, setPlaying] = useState(false);

  const preview = async () => {
    setPlaying(true);
    try {
      const res = await fetch(voicePaths.preview, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ voice: value }),
      });
      if (!res.ok)
        throw new Error(
          ((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? res.statusText,
        );
      const url = URL.createObjectURL(await res.blob());
      const audio = new Audio(url);
      audio.onended = () => URL.revokeObjectURL(url);
      await audio.play();
    } catch (e) {
      toast.error(`Preview failed: ${(e as Error).message}`);
    } finally {
      setPlaying(false);
    }
  };

  if (!voices.data) {
    return (
      <div>
        <Input
          aria-label="Voice"
          placeholder="Default voice"
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value.trim() || null)}
        />
        <p className="mt-1 text-muted-foreground text-xs">
          {voices.isLoading
            ? "Loading voices…"
            : "The voice service is offline, so the list isn't available."}
        </p>
      </div>
    );
  }
  const list = voices.data.voices;
  const other = list.filter((v) => !GROUPS.some(([p]) => v.startsWith(`${p}_`)));
  return (
    <div className="flex gap-2">
      <Select value={value ?? DEFAULT} onValueChange={(v) => onChange(v === DEFAULT ? null : v)}>
        <SelectTrigger aria-label="Voice" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={DEFAULT}>Default ({voiceName(voices.data.default)})</SelectItem>
          {value && !list.includes(value) && <SelectItem value={value}>{value} (not offered)</SelectItem>}
          {GROUPS.map(([prefix, label]) => {
            const items = list.filter((v) => v.startsWith(`${prefix}_`));
            if (!items.length) return null;
            return (
              <SelectGroup key={prefix}>
                <SelectLabel>{label}</SelectLabel>
                {items.map((v) => (
                  <SelectItem key={v} value={v}>
                    {voiceName(v)}
                  </SelectItem>
                ))}
              </SelectGroup>
            );
          })}
          {other.map((v) => (
            <SelectItem key={v} value={v}>
              {v}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        type="button"
        variant="outline"
        size="icon"
        aria-label="Preview voice"
        onClick={preview}
        disabled={playing}
      >
        {playing ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
      </Button>
    </div>
  );
}

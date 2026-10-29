import { createFileRoute } from "@tanstack/react-router";
import type { ServiceHealth, VoiceSettings, VoiceSettingsPatchBody, WorkerMode } from "@vibe-center/shared";
import { Cpu, Loader2, Power, RefreshCw, RotateCw } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  useGpuSpeech,
  useRestartVoiceWorker,
  useSaveVoiceSettings,
  useVoiceSettings,
  useVoiceStatus,
} from "@/lib/queries";
import { Section } from "../settings";

export const Route = createFileRoute("/_app/settings/voice")({ component: Voice });

const stateLabel: Record<ServiceHealth["state"], string> = {
  ok: "Working",
  starting: "Starting",
  down: "Offline",
  error: "Error",
  off: "Not used",
};

function ServiceBadge({ health, testId }: { health: ServiceHealth | undefined; testId: string }) {
  if (!health) return <Badge variant="outline">Checking…</Badge>;
  const variant =
    health.state === "ok"
      ? "secondary"
      : health.state === "error" || health.state === "down"
        ? "destructive"
        : "outline";
  return (
    <Badge
      variant={variant}
      data-testid={testId}
      data-state={health.state}
      title={health.message ?? undefined}
    >
      {stateLabel[health.state]}
    </Badge>
  );
}

function Voice() {
  const settings = useVoiceSettings();
  if (!settings.data) return null;
  return <VoiceForm settings={settings.data} />;
}

function VoiceForm({ settings }: { settings: VoiceSettings }) {
  const status = useVoiceStatus({ poll: true });
  const save = useSaveVoiceSettings();
  const restart = useRestartVoiceWorker();
  const gpu = useGpuSpeech();
  const [form, setForm] = useState({ ...settings, workerToken: "" });
  useEffect(() => setForm((f) => ({ ...settings, workerToken: f.workerToken })), [settings]);
  const s = status.data;

  const patch = (p: VoiceSettingsPatchBody) =>
    save.mutate(p, {
      onSuccess: () => toast.success("Voice settings saved"),
      onError: (e) => toast.error(e.message),
    });
  const saveUrls = () => {
    const p: VoiceSettingsPatchBody = {
      sttUrl: form.sttUrl.trim(),
      ttsUrl: form.ttsUrl.trim(),
      workerUrl: form.workerUrl.trim(),
      appUrl: form.appUrl.trim(),
    };
    if (form.workerToken) p.workerToken = form.workerToken;
    patch(p);
    setForm((f) => ({ ...f, workerToken: "" }));
  };

  return (
    <div className="space-y-8">
      <Section title="Voice worker">
        <div className="space-y-3 rounded-lg border p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-sm">Worker</span>
            <ServiceBadge health={s?.worker} testId="voice-worker-health" />
            {s?.worker.message && <span className="text-muted-foreground text-xs">{s.worker.message}</span>}
            <span className="flex-1" />
            {settings.workerMode === "managed" && (
              <Button size="sm" variant="ghost" disabled={restart.isPending} onClick={() => restart.mutate()}>
                <RotateCw className="size-3.5" /> Restart
              </Button>
            )}
          </div>
          <Label className="block">
            <span className="mb-1.5 block">Runs as</span>
            <Select value={settings.workerMode} onValueChange={(v) => patch({ workerMode: v as WorkerMode })}>
              <SelectTrigger aria-label="Worker mode" className="w-full sm:w-80">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="managed">A process this app manages (services/voice)</SelectItem>
                <SelectItem value="remote">A worker at a URL (another machine)</SelectItem>
              </SelectContent>
            </Select>
          </Label>
          {settings.workerMode === "managed" ? (
            <p className="text-muted-foreground text-xs">
              {s?.worker.pid ? `pid ${s.worker.pid}` : "not running"}
              {s?.worker.url ? ` · ${s.worker.url}` : ""}
              {s?.worker.version ? ` · v${s.worker.version}` : ""}
              {s?.worker.restarts ? ` · restarted ${s.worker.restarts}×` : ""} · started with the app,
              restarted when it crashes. Log: ~/.vibe-center/logs/voice-worker.log
            </p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label="Worker URL"
                hint="e.g. http://km-pc.tailnet:7860 (run services/voice/run.sh there)"
              >
                <Input
                  aria-label="Worker URL"
                  value={form.workerUrl}
                  placeholder="http://host:7860"
                  onChange={(e) => setForm({ ...form, workerUrl: e.target.value })}
                />
              </Field>
              <Field label="Worker token" hint="The VC_WORKER_TOKEN the remote worker was started with.">
                <Input
                  type="password"
                  value={form.workerToken}
                  placeholder={settings.workerTokenSet ? "•••••••• (set)" : "not set"}
                  onChange={(e) => setForm({ ...form, workerToken: e.target.value })}
                />
              </Field>
              <Field label="This app, as the worker reaches it" hint="Empty: the tailnet https URL.">
                <Input
                  value={form.appUrl}
                  placeholder="https://dev.your-tailnet.ts.net:7443"
                  onChange={(e) => setForm({ ...form, appUrl: e.target.value })}
                />
              </Field>
            </div>
          )}
          {settings.workerMode === "managed" && s?.worker.logTail.length ? (
            <details>
              <summary className="cursor-pointer text-muted-foreground text-xs">Worker log</summary>
              <pre className="mt-2 max-h-64 overflow-auto rounded bg-muted p-2 text-[11px] leading-snug">
                {s.worker.logTail.slice(-60).join("\n")}
              </pre>
            </details>
          ) : null}
        </div>
      </Section>

      <Section title="Speech">
        <div className="space-y-3 rounded-lg border p-3">
          <p className="text-muted-foreground text-xs">
            OpenAI-compatible servers. Defaults are the GPU servers on km-pc through the tunnels that{" "}
            <code>speech.sh up</code> opens. Leave a field empty, or let the server be offline, and the worker
            uses its CPU models (Whisper base.en, Kokoro) instead, per call.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Speech to text (STT)"
              status={<ServiceBadge health={s?.stt} testId="voice-stt-health" />}
            >
              <Input
                aria-label="STT URL"
                value={form.sttUrl}
                onChange={(e) => setForm({ ...form, sttUrl: e.target.value })}
              />
              {s?.stt.message && (
                <span className="mt-1 block text-muted-foreground text-xs">{s.stt.message}</span>
              )}
            </Field>
            <Field
              label="Text to speech (TTS)"
              status={<ServiceBadge health={s?.tts} testId="voice-tts-health" />}
            >
              <Input
                aria-label="TTS URL"
                value={form.ttsUrl}
                onChange={(e) => setForm({ ...form, ttsUrl: e.target.value })}
              />
              {s?.tts.message && (
                <span className="mt-1 block text-muted-foreground text-xs">{s.tts.message}</span>
              )}
            </Field>
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={saveUrls} disabled={save.isPending}>
              Save
            </Button>
          </div>
          {s?.gpuSpeech.available && (
            <div className="space-y-2 border-t pt-3">
              <div className="flex flex-wrap items-center gap-2">
                <Cpu className="size-4 text-muted-foreground" />
                <span className="font-medium text-sm">GPU speech on km-pc</span>
                {s.gpuSpeech.running && (
                  <span className="flex items-center gap-1 text-muted-foreground text-xs">
                    <Loader2 className="size-3 animate-spin" /> speech.sh {s.gpuSpeech.running}…
                  </span>
                )}
                <span className="flex-1" />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!!s.gpuSpeech.running || gpu.isPending}
                  onClick={() => gpu.mutate("up", { onError: (e) => toast.error(e.message) })}
                >
                  <Power className="size-3.5" /> Start GPU speech
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!!s.gpuSpeech.running || gpu.isPending}
                  onClick={() => gpu.mutate("status", { onError: (e) => toast.error(e.message) })}
                >
                  <RefreshCw className="size-3.5" /> Status
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!!s.gpuSpeech.running || gpu.isPending}
                  onClick={() => gpu.mutate("down", { onError: (e) => toast.error(e.message) })}
                >
                  Stop
                </Button>
              </div>
              <p className="text-muted-foreground text-xs">
                Wakes km-pc, starts Parakeet STT and Kokoro TTS there and opens the tunnels
                (services/speech-gpu/speech.sh). It refuses while someone is using km-pc. Stopping leaves
                km-pc awake: run <code>gpu sleep</code> when nothing else needs it.
              </p>
              {s.gpuSpeech.lastOutput && (
                <pre className="max-h-48 overflow-auto rounded bg-muted p-2 text-[11px] leading-snug">
                  {`$ speech.sh ${s.gpuSpeech.running ?? s.gpuSpeech.lastAction ?? ""}${
                    s.gpuSpeech.lastExitCode !== null && !s.gpuSpeech.running
                      ? `  (exit ${s.gpuSpeech.lastExitCode})`
                      : ""
                  }\n${s.gpuSpeech.lastOutput}`}
                </pre>
              )}
            </div>
          )}
        </div>
      </Section>

      <Section title="Calls">
        <div className="flex items-start gap-3 rounded-lg border p-3">
          <Switch
            id="voice-filler"
            checked={settings.filler}
            onCheckedChange={(v) => patch({ filler: v })}
            aria-label="Filler cues"
          />
          <Label htmlFor="voice-filler" className="block">
            <span className="block font-medium text-sm">Filler cues</span>
            <span className="block font-normal text-muted-foreground text-xs">
              Say "One sec." or "Let me check." when the agent starts a tool before saying anything. The end
              of your turn is silent either way.
            </span>
          </Label>
        </div>
        <p className="text-muted-foreground text-xs">
          Each agent's voice is set in its editor. Use a headset: with laptop speakers the agent's voice can
          interrupt itself.
        </p>
      </Section>
    </div>
  );
}

function Field({
  label,
  hint,
  status,
  children,
}: {
  label: string;
  hint?: string;
  status?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <Label className="mb-1.5 flex items-center gap-2">
        {label}
        {status}
      </Label>
      {children}
      {hint && <p className="mt-1 text-muted-foreground text-xs">{hint}</p>}
    </div>
  );
}

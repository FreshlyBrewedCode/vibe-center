import type { SttModel, SttModelsResponse, VoiceSettings, VoiceSettingsPatchBody } from "@vibe-center/shared";
import { MAX_RECORD_TURNS, voicePaths } from "@vibe-center/shared";
import { Check, Download, Loader2, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  type SttModelCommand,
  useClearRecordings,
  useRecordings,
  useSttModelAction,
  useSttModels,
} from "@/lib/queries";

// Settings → Voice → Speech to text: the STT server's models (a dictation-app style picker), the
// custom vocabulary and the debug turn recordings. Structural on purpose: a redesign comes later.

/** 1–5 from the measured server time per utterance. */
const speedLevel = (ms: number) => (ms <= 70 ? 5 : ms <= 120 ? 4 : ms <= 200 ? 3 : ms <= 400 ? 2 : 1);
/** 1–5 from the WER on the project's eval set. */
const accuracyLevel = (wer: number) => (wer <= 3.5 ? 5 : wer <= 5 ? 4 : wer <= 8 ? 3 : wer <= 12 ? 2 : 1);

function Meter({ label, level, detail }: { label: string; level: number | null; detail: string }) {
  return (
    <span className="inline-flex items-center gap-1.5" title={detail}>
      <span className="text-muted-foreground">{label}</span>
      {level === null ? (
        <span className="text-muted-foreground">n/a</span>
      ) : (
        <span className="inline-flex gap-0.5" data-level={level}>
          {[1, 2, 3, 4, 5].map((i) => (
            <span
              key={i}
              aria-hidden
              className={`h-2 w-2 rounded-full ${i <= level ? "bg-foreground" : "bg-line-strong"}`}
            />
          ))}
          <span className="sr-only">{level} of 5</span>
        </span>
      )}
      <span className="text-muted-foreground">{detail}</span>
    </span>
  );
}

const mb = (n: number) => (n >= 1000 ? `${(n / 1024).toFixed(1)} GB` : `${n} MB`);

const phaseLabel: Record<NonNullable<SttModel["progress"]>["phase"], string> = {
  starting: "Starting…",
  runtime: "Installing the Whisper runtime (CUDA 12)…",
  download: "Downloading…",
  convert: "Converting to fp16…",
};

export function SttModels() {
  const q = useSttModels();
  const act = useSttModelAction();
  const run = (id: string, action: SttModelCommand) =>
    act.mutate({ id, action }, { onError: (e) => toast.error(e.message) });
  const d = q.data;
  if (!d) return <p className="text-muted-foreground text-xs">Checking the STT server…</p>;
  if (!d.reachable)
    return (
      <div
        className="rounded-xl border border-line border-dashed p-4 text-sm"
        data-testid="stt-models-offline"
      >
        <p>{d.message}</p>
        <p className="mt-1 text-muted-foreground text-xs">
          Models are listed, downloaded and switched on the STT server ({d.url || "not set"}). Start it (GPU
          speech above, or <code>services/speech-gpu/speech.sh up</code>) to choose one.
        </p>
      </div>
    );
  return (
    <ul className="divide-y divide-line rounded-xl border border-line bg-card" data-testid="stt-models">
      {d.models.map((m) => (
        <SttModelRow key={m.id} m={m} list={d} busy={act.isPending} run={run} />
      ))}
    </ul>
  );
}

function SttModelRow({
  m,
  list,
  busy,
  run,
}: {
  m: SttModel;
  list: SttModelsResponse;
  busy: boolean;
  run: (id: string, action: SttModelCommand) => void;
}) {
  const p = m.progress;
  const switching = list.loading !== null;
  return (
    <li className="space-y-2 p-4" data-testid={`stt-model-${m.id}`} data-status={m.status}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-sm">{m.name}</span>
        {m.recommended && <Badge variant="outline">Recommended</Badge>}
        {m.status === "active" && (
          <Badge variant="ok">
            <Check className="size-3" /> In use
          </Badge>
        )}
        {m.status === "loading" && (
          <Badge variant="outline">
            <Loader2 className="size-3 animate-spin" /> Loading
          </Badge>
        )}
        <span className="flex-1" />
        {m.status === "absent" && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => run(m.id, "download")}>
            <Download className="size-3.5" /> Download · {mb(m.downloadMb)}
          </Button>
        )}
        {m.status === "downloading" && (
          <Button size="sm" variant="quiet" disabled={busy} onClick={() => run(m.id, "cancel")}>
            <X className="size-3.5" /> Cancel
          </Button>
        )}
        {m.status === "ready" && (
          <>
            <Button size="sm" disabled={busy || switching} onClick={() => run(m.id, "activate")}>
              Use
            </Button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="icon-sm" variant="quiet" aria-label={`Delete ${m.name}`}>
                  <Trash2 className="size-3.5" />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete {m.name}?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Frees {mb(m.diskMb)} on the speech server. You can download it again later.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={() => run(m.id, "delete")}>Delete</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </>
        )}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <Meter label="Speed" level={speedLevel(m.latencyMs)} detail={`~${m.latencyMs} ms`} />
        <Meter
          label="Accuracy"
          level={m.wer === null ? null : accuracyLevel(m.wer)}
          detail={m.wer === null ? "" : `${m.wer.toFixed(1)}% WER`}
        />
        <span className="text-muted-foreground">
          {m.languages.join(", ")} · {mb(m.vramMb)} VRAM ·{" "}
          {m.status === "absent" || m.status === "downloading"
            ? `${mb(m.downloadMb)} download`
            : `${mb(m.diskMb)} on disk`}{" "}
          · {m.supportsVocabulary ? "uses the custom vocabulary" : "no custom vocabulary"}
        </span>
      </div>
      <p className="text-muted-foreground text-xs">{m.accuracy}</p>
      {p && (
        <div className="space-y-1" data-testid={`stt-progress-${m.id}`}>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className={`h-full bg-primary ${p.fraction === null ? "w-1/3 animate-pulse" : ""}`}
              style={p.fraction === null ? undefined : { width: `${Math.round(p.fraction * 100)}%` }}
            />
          </div>
          <p className="text-muted-foreground text-xs">
            {phaseLabel[p.phase]}
            {p.fraction !== null &&
              ` ${Math.round(p.fraction * 100)}% · ${mb(Math.round(p.doneBytes / 2 ** 20))} of ${mb(Math.round(p.totalBytes / 2 ** 20))}`}
          </p>
        </div>
      )}
      {m.error && <p className="text-destructive text-xs">{m.error}</p>}
    </li>
  );
}

const LANGUAGES: [string, string][] = [
  ["en", "English"],
  ["auto", "Detect automatically"],
  ["de", "German"],
  ["fr", "French"],
  ["es", "Spanish"],
  ["it", "Italian"],
  ["nl", "Dutch"],
  ["pl", "Polish"],
  ["pt", "Portuguese"],
];

export function SttLanguage({
  settings,
  patch,
}: {
  settings: VoiceSettings;
  patch: (p: VoiceSettingsPatchBody) => void;
}) {
  const active = useSttModels().data?.models.find((m) => m.status === "active");
  const englishOnly = active && active.languages.length === 1 && active.languages[0] === "en";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Label htmlFor="stt-language" className="font-medium text-sm">
        Language you speak
      </Label>
      <Select
        value={settings.sttLanguage || "auto"}
        onValueChange={(v) => patch({ sttLanguage: v === "auto" ? "" : v })}
      >
        <SelectTrigger id="stt-language" aria-label="Speech language" className="w-56">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {LANGUAGES.map(([code, name]) => (
            <SelectItem key={code} value={code}>
              {name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <span className="text-muted-foreground text-xs">
        {englishOnly
          ? `${active.name} only understands English.`
          : "Multilingual models use it; detecting it costs Whisper ~140 ms per turn."}
      </span>
    </div>
  );
}

/** One term per line (commas also split). */
const parseTerms = (text: string) =>
  [
    ...new Set(
      text
        .split(/[\n,]/)
        .map((t) => t.trim())
        .filter(Boolean),
    ),
  ].slice(0, 200);

export function SttVocabulary({
  settings,
  patch,
  saving,
}: {
  settings: VoiceSettings;
  patch: (p: VoiceSettingsPatchBody) => void;
  saving: boolean;
}) {
  const models = useSttModels().data;
  const [text, setText] = useState(settings.sttVocabulary.join("\n"));
  useEffect(() => setText(settings.sttVocabulary.join("\n")), [settings.sttVocabulary]);
  const active = models?.models.find((m) => m.status === "active");
  const dirty = parseTerms(text).join("\n") !== settings.sttVocabulary.join("\n");
  return (
    <div className="space-y-2">
      <Label htmlFor="stt-vocabulary" className="block">
        <span className="block font-medium text-sm">Custom vocabulary</span>
        <span className="block font-normal text-muted-foreground text-xs">
          Project names and jargon the speech recognition should get right, one per line. Your agents' names
          are added automatically.
        </span>
      </Label>
      <Textarea
        id="stt-vocabulary"
        value={text}
        rows={4}
        placeholder={"Vibe Center\nPipecat\nTailscale"}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={!dirty || saving}
          onClick={() => patch({ sttVocabulary: parseTerms(text) })}
        >
          Save vocabulary
        </Button>
        <span className="text-xs" data-testid="stt-vocabulary-support">
          {!models?.reachable ? (
            <span className="text-muted-foreground">
              Without the STT server, calls use the worker's CPU Whisper, which uses the vocabulary.
            </span>
          ) : active && !active.supportsVocabulary ? (
            <span className="font-medium">
              {active.name} can't use a custom vocabulary: it is ignored until you pick a Whisper model.
            </span>
          ) : active ? (
            <span className="text-muted-foreground">{active.name} uses it.</span>
          ) : null}
        </span>
      </div>
    </div>
  );
}

export function TurnRecordings({
  settings,
  patch,
}: {
  settings: VoiceSettings;
  patch: (p: VoiceSettingsPatchBody) => void;
}) {
  const on = settings.recordTurns > 0;
  const [keep, setKeep] = useState(String(settings.recordTurns || 20));
  const recordings = useRecordings(true);
  const clear = useClearRecordings();
  const items = recordings.data?.recordings ?? [];
  return (
    <div className="space-y-3 rounded-xl border border-line bg-card p-4">
      <div className="flex items-start gap-3">
        <Switch
          id="voice-record"
          checked={on}
          onCheckedChange={(v) => patch({ recordTurns: v ? Math.max(1, Number(keep) || 20) : 0 })}
          aria-label="Keep turn recordings"
        />
        <Label htmlFor="voice-record" className="block flex-1">
          <span className="block font-medium text-sm">Keep recordings of recent turns</span>
          <span className="block font-normal text-muted-foreground text-xs">
            For checking misrecognitions: the worker keeps what the speech recognition heard in calls, with
            its transcript, on its own disk (<code>~/.vibe-center/voice/recordings</code>). Off by default.
          </span>
        </Label>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground text-xs">Keep the last</span>
        <Input
          aria-label="Recordings to keep"
          className="h-8 w-20"
          type="number"
          min={1}
          max={MAX_RECORD_TURNS}
          value={keep}
          onChange={(e) => setKeep(e.target.value)}
          onBlur={() => {
            const n = Math.min(MAX_RECORD_TURNS, Math.max(1, Math.round(Number(keep)) || 20));
            setKeep(String(n));
            if (on && n !== settings.recordTurns) patch({ recordTurns: n });
          }}
        />
        <span className="text-muted-foreground text-xs">turns</span>
        <span className="flex-1" />
        <Button
          size="sm"
          variant="outline"
          disabled={items.length === 0 || clear.isPending}
          onClick={() =>
            clear.mutate(undefined, {
              onSuccess: (r) => toast.success(`Deleted ${r.deleted} recording${r.deleted === 1 ? "" : "s"}`),
              onError: (e) => toast.error(e.message),
            })
          }
        >
          <Trash2 className="size-3.5" /> Clear{items.length ? ` ${items.length}` : ""}
        </Button>
      </div>
      {recordings.isError && (
        <p className="text-muted-foreground text-xs">
          The voice worker isn't running: no recordings to show.
        </p>
      )}
      {items.length > 0 && (
        <ul
          className="vc-scroll max-h-80 divide-y divide-line overflow-auto rounded-lg border border-line bg-background"
          data-testid="turn-recordings"
        >
          {items.map((r) => (
            <li key={r.id} className="space-y-1 p-2.5">
              <div className="flex flex-wrap items-baseline gap-2 text-xs">
                <span className="text-muted-foreground">
                  {new Date(r.at).toLocaleString()} · {r.duration.toFixed(1)} s · {r.stt}
                </span>
              </div>
              <p className="text-sm">“{r.text}”</p>
              {/* biome-ignore lint/a11y/useMediaCaption: speech recordings have no captions; the transcript is above */}
              <audio controls preload="none" src={voicePaths.recording(r.id)} className="h-8 w-full" />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

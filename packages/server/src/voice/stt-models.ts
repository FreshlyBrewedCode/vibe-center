import type { SttModel, SttModelAction, SttModelsResponse } from "@vibe-center/shared";
import { HttpError } from "../domain/errors.ts";

/** The STT server's model as it sends it (services/speech-gpu/models.py, snake_case). */
interface RawModel {
  id: string;
  name: string;
  backend: string;
  download_mb: number;
  disk_mb: number;
  vram_mb: number;
  latency_ms: number;
  wer: number | null;
  languages: string[];
  accuracy: string;
  supports_vocabulary: boolean;
  recommended: boolean;
  status: SttModel["status"];
  progress: { phase: string; done_bytes: number; total_bytes: number; fraction: number | null } | null;
  error: string | null;
}

interface RawList {
  active: string | null;
  loading: string | null;
  default: string | null;
  models: RawModel[];
}

function model(m: RawModel): SttModel {
  return {
    id: m.id,
    name: m.name,
    backend: m.backend,
    downloadMb: m.download_mb,
    diskMb: m.disk_mb,
    vramMb: m.vram_mb,
    latencyMs: m.latency_ms,
    wer: m.wer,
    languages: m.languages,
    accuracy: m.accuracy,
    supportsVocabulary: m.supports_vocabulary,
    recommended: m.recommended,
    status: m.status,
    progress: m.progress && {
      phase: m.progress.phase as NonNullable<SttModel["progress"]>["phase"],
      doneBytes: m.progress.done_bytes,
      totalBytes: m.progress.total_bytes,
      fraction: m.progress.fraction,
    },
    error: m.error,
  };
}

const offline = (url: string, message: string): SttModelsResponse => ({
  url,
  reachable: false,
  message,
  active: null,
  loading: null,
  default: null,
  models: [],
});

/**
 * The STT server's model catalog (services/speech-gpu: GET/POST/DELETE /v1/stt/models…), through
 * the app, so it works wherever the server runs. Listing never throws: an offline server, or an
 * OpenAI-compatible one without a catalog, comes back as `reachable: false` with the reason.
 */
export async function listSttModels(url: string): Promise<SttModelsResponse> {
  if (!url) return offline(url, "No STT server is set: calls use the worker's CPU Whisper.");
  let res: Response;
  try {
    res = await fetch(`${base(url)}/v1/stt/models`, { signal: AbortSignal.timeout(3000) });
  } catch {
    return offline(url, "The STT server is offline: calls use the worker's CPU Whisper.");
  }
  if (res.status === 404)
    return offline(url, "This STT server has no model catalog: it serves one fixed model.");
  if (!res.ok) return offline(url, `The STT server answered ${res.status}.`);
  const raw = (await res.json()) as RawList;
  return {
    url,
    reachable: true,
    message: null,
    active: raw.active,
    loading: raw.loading,
    default: raw.default,
    models: raw.models.map(model),
  };
}

/** download | activate (POST), cancel (DELETE …/download), delete (DELETE). Returns the model. */
export async function sttModelAction(
  url: string,
  id: string,
  action: SttModelAction | "cancel" | "delete",
): Promise<SttModel> {
  if (!url) throw new HttpError(409, "No STT server is set.", "settings:voice");
  const path = `${base(url)}/v1/stt/models/${encodeURIComponent(id)}`;
  const [method, target] =
    action === "delete"
      ? ["DELETE", path]
      : action === "cancel"
        ? ["DELETE", `${path}/download`]
        : ["POST", `${path}/${action}`];
  let res: Response;
  try {
    res = await fetch(target, { method, signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new HttpError(503, "The STT server is offline.", "settings:voice");
  }
  if (!res.ok) {
    const detail = await res
      .json()
      .then((b) => (b as { detail?: string }).detail)
      .catch(() => null);
    const status = res.status === 404 || res.status === 409 ? res.status : 502;
    throw new HttpError(status, detail ?? `The STT server answered ${res.status}.`);
  }
  return model((await res.json()) as RawModel);
}

const base = (url: string) => url.replace(/\/$/, "");

// Thin JSON client for the server's /api. Types come from @vibe-center/shared; the server
// validates bodies with the zod schemas from there too.
import type { ApiError as ApiErrorBody } from "@vibe-center/shared";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Points at the setting that fixes it, e.g. "harness:claude-code". */
    readonly hint?: string,
  ) {
    super(message);
  }
}

let onUnauthorized: () => void = () => {};
/** Called on any 401, so the app can drop to the signed-out screen. */
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401) onUnauthorized();
    const err = data as ApiErrorBody | null;
    throw new ApiError(res.status, err?.error ?? `${res.status} ${res.statusText}`, err?.hint);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}),
  patch: <T>(path: string, body: unknown) => request<T>("PATCH", path, body),
  delete: <T = void>(path: string) => request<T>("DELETE", path),
};

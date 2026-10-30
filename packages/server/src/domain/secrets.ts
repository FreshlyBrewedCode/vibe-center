import type { SecretInput, SecretMap } from "@vibe-center/shared";
import { HttpError } from "./errors.ts";

/** Last 4 characters of long values only, so short secrets don't leak half their content. */
export function maskSecrets(m: Record<string, string>): SecretMap {
  return Object.fromEntries(
    Object.entries(m).map(([k, v]) => [k, { hint: v.length >= 12 ? v.slice(-4) : "" }]),
  );
}

/** New values replace, `{ keep: true }` keeps the stored value, keys left out are removed. */
export function resolveSecrets(input: SecretInput, stored: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === "string") out[k] = v;
    else if (k in stored) out[k] = stored[k]!;
    else throw new HttpError(400, `no stored value to keep for ${k}`);
  }
  return out;
}

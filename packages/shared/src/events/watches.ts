// Events of background waits (watches).
import type { Watch } from "../domain.ts";

export type WatchEvent =
  /** A watch was registered, fired, cancelled or expired. */
  { type: "watch.upsert"; watch: Watch };

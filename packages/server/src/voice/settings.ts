import { DEFAULT_VOICE_SETTINGS, type VoiceSettings, type VoiceSettingsPatchBody } from "@vibe-center/shared";
import type { Db } from "../db/index.ts";

const KEY = "voice";

/** What's stored: the public settings plus the remote worker's token. */
export interface StoredVoiceSettings extends Omit<VoiceSettings, "workerTokenSet"> {
  workerToken: string;
}

/** Voice settings in the `settings` table (one JSON row), merged over the defaults on read. */
export class VoiceSettingsStore {
  constructor(private readonly db: Db) {}

  get(): StoredVoiceSettings {
    const row = this.db
      .query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?")
      .get(KEY);
    const { workerTokenSet: _, ...defaults } = DEFAULT_VOICE_SETTINGS;
    const stored = row ? (JSON.parse(row.value) as Partial<StoredVoiceSettings>) : {};
    return { ...defaults, workerToken: "", ...stored };
  }

  update(patch: VoiceSettingsPatchBody): StoredVoiceSettings {
    const next = { ...this.get(), ...stripUndefined(patch) };
    this.db
      .query(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(KEY, JSON.stringify(next));
    return next;
  }
}

export function publicSettings(s: StoredVoiceSettings): VoiceSettings {
  const { workerToken, ...rest } = s;
  return { ...rest, workerTokenSet: workerToken.length > 0 };
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

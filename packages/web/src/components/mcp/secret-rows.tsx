import type { SecretInput, SecretMap } from "@vibe-center/shared";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** One env var or header row. A stored secret shows as `stored` until a new value is typed. */
export interface SecretRow {
  key: string;
  value: string;
  stored: { hint: string } | null;
}

export const rowsOf = (m: SecretMap | undefined): SecretRow[] =>
  Object.entries(m ?? {}).map(([key, s]) => ({ key, value: "", stored: s }));

export function secretRowsToInput(rows: SecretRow[]): SecretInput {
  const out: SecretInput = {};
  for (const r of rows) {
    const key = r.key.trim();
    if (!key) continue;
    out[key] = r.value === "" && r.stored ? { keep: true } : r.value;
  }
  return out;
}

/** Shared editor for a secret-bearing map (MCP env/headers, custom harness env). Write-only. */
export function SecretRows({
  label,
  rows,
  onChange,
  keyPlaceholder,
}: {
  label: string;
  rows: SecretRow[];
  onChange: (rows: SecretRow[]) => void;
  keyPlaceholder: string;
}) {
  const set = (i: number, patch: Partial<SecretRow>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <fieldset className="space-y-1.5">
      <legend className="font-medium text-sm">{label}</legend>
      <p className="text-muted-foreground text-xs">Values are stored on the server and never shown again.</p>
      {rows.map((r, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity while being edited
        <div key={i} className="flex gap-2">
          <Input
            aria-label={`${label} name`}
            className="w-2/5 font-mono text-xs"
            value={r.key}
            placeholder={keyPlaceholder}
            onChange={(e) => set(i, { key: e.target.value })}
          />
          <Input
            aria-label={`${label} value`}
            type="password"
            autoComplete="off"
            className="flex-1 font-mono text-xs"
            value={r.value}
            placeholder={r.stored ? `unchanged${r.stored.hint ? ` (…${r.stored.hint})` : ""}` : "value"}
            onChange={(e) => set(i, { value: e.target.value })}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Remove"
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
          >
            <X className="size-4" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => onChange([...rows, { key: "", value: "", stored: null }])}
      >
        <Plus className="size-3.5" /> Add
      </Button>
    </fieldset>
  );
}

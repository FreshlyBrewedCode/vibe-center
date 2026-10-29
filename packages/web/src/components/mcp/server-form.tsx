import type { McpServerBody, McpServerView, SecretInput } from "@vibe-center/shared";
import { Plus, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useSaveMcpServer } from "@/lib/queries";

/** One env var or header row. A stored secret shows as `stored` until a new value is typed. */
interface SecretRow {
  key: string;
  value: string;
  stored: { hint: string } | null;
}

const rowsOf = (m: McpServerView["env"] | undefined): SecretRow[] =>
  Object.entries(m ?? {}).map(([key, s]) => ({ key, value: "", stored: s }));

function toInput(rows: SecretRow[]): SecretInput {
  const out: SecretInput = {};
  for (const r of rows) {
    const key = r.key.trim();
    if (!key) continue;
    out[key] = r.value === "" && r.stored ? { keep: true } : r.value;
  }
  return out;
}

/** Add or edit an MCP server (stdio command or HTTP URL). Secrets are write-only. */
export function McpServerDialog({
  server,
  open,
  onOpenChange,
}: {
  server?: McpServerView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const save = useSaveMcpServer(server?.id);
  const [name, setName] = useState(server?.name ?? "");
  const [transport, setTransport] = useState<"stdio" | "http">(
    server?.transport === "http" ? "http" : "stdio",
  );
  const [command, setCommand] = useState(server?.command ?? "");
  const [args, setArgs] = useState((server?.args ?? []).join("\n"));
  const [cwd, setCwd] = useState(server?.cwd ?? "");
  const [url, setUrl] = useState(server?.url ?? "");
  const [env, setEnv] = useState<SecretRow[]>(rowsOf(server?.env));
  const [headers, setHeaders] = useState<SecretRow[]>(rowsOf(server?.headers));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const body: McpServerBody = {
      name: name.trim(),
      transport,
      command: transport === "stdio" ? command.trim() || null : null,
      args: transport === "stdio" ? args.split("\n").filter((a) => a.trim() !== "") : [],
      cwd: transport === "stdio" ? cwd.trim() || null : null,
      url: transport === "http" ? url.trim() || null : null,
      env: transport === "stdio" ? toInput(env) : {},
      headers: transport === "http" ? toInput(headers) : {},
    };
    save.mutate(body, {
      onSuccess: () => {
        toast.success(server ? "Saved; reconnecting." : "Added; connecting.");
        onOpenChange(false);
      },
      onError: (err) => toast.error(err.message),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{server ? `Edit ${server.name}` : "Add MCP server"}</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-[1fr_8rem] gap-3">
            <Label className="block space-y-1.5">
              <span>Name</span>
              <Input required value={name} placeholder="github" onChange={(e) => setName(e.target.value)} />
            </Label>
            <Label className="block space-y-1.5">
              <span>Transport</span>
              <Select value={transport} onValueChange={(v) => setTransport(v as "stdio" | "http")}>
                <SelectTrigger aria-label="Transport" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="stdio">stdio</SelectItem>
                  <SelectItem value="http">HTTP</SelectItem>
                </SelectContent>
              </Select>
            </Label>
          </div>
          <p className="-mt-2 text-muted-foreground text-xs">
            Lowercase, also the tool prefix: agents see <code>{name || "name"}__tool</code>.
          </p>
          {transport === "stdio" ? (
            <>
              <Label className="block space-y-1.5">
                <span>Command</span>
                <Input
                  required
                  value={command}
                  placeholder="npx"
                  onChange={(e) => setCommand(e.target.value)}
                />
              </Label>
              <Label className="block space-y-1.5">
                <span>Arguments (one per line)</span>
                <Textarea
                  rows={3}
                  value={args}
                  placeholder={"-y\n@modelcontextprotocol/server-everything"}
                  onChange={(e) => setArgs(e.target.value)}
                />
              </Label>
              <Label className="block space-y-1.5">
                <span>Working directory (optional)</span>
                <Input value={cwd} placeholder="~" onChange={(e) => setCwd(e.target.value)} />
              </Label>
              <SecretRows label="Environment" rows={env} onChange={setEnv} keyPlaceholder="API_KEY" />
            </>
          ) : (
            <>
              <Label className="block space-y-1.5">
                <span>URL</span>
                <Input
                  required
                  type="url"
                  value={url}
                  placeholder="https://example.com/mcp"
                  onChange={(e) => setUrl(e.target.value)}
                />
              </Label>
              <SecretRows
                label="Headers"
                rows={headers}
                onChange={setHeaders}
                keyPlaceholder="Authorization"
              />
            </>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {server ? "Save" : "Add server"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SecretRows({
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

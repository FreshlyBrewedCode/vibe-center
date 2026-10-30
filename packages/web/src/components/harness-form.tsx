import type { Harness, HarnessBody, SecretInput, SecretMap } from "@vibe-center/shared";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useSaveHarness } from "@/lib/queries";

function parseArgs(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Stored values never come back from the API: an empty `KEY=` keeps the stored one. */
function parseEnv(text: string, stored: SecretMap): SecretInput {
  const env: SecretInput = {};
  for (const line of text.split("\n").map((l) => l.trim())) {
    if (!line) continue;
    const i = line.indexOf("=");
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim();
    env[key] = value === "" && key in stored ? { keep: true } : value;
  }
  return env;
}

function toLines(args: string[]): string {
  return args.join("\n");
}

function envToLines(env: SecretMap): string {
  return Object.keys(env)
    .map((k) => `${k}=`)
    .join("\n");
}

/**
 * Create or edit a custom harness (command, args, env). The API already supports full CRUD
 * (`HarnessBody`); this is the form for it. Rendered inside a Dialog via `trigger`.
 */
export function HarnessFormDialog({ harness, trigger }: { harness?: Harness; trigger: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const save = useSaveHarness(harness?.id);
  const [name, setName] = useState(harness?.name ?? "");
  const [command, setCommand] = useState(harness?.command ?? "");
  const [args, setArgs] = useState(toLines(harness?.args ?? []));
  const [env, setEnv] = useState(envToLines(harness?.env ?? {}));

  const reset = () => {
    setName(harness?.name ?? "");
    setCommand(harness?.command ?? "");
    setArgs(toLines(harness?.args ?? []));
    setEnv(envToLines(harness?.env ?? {}));
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const body: HarnessBody = {
      name,
      command,
      args: parseArgs(args),
      env: parseEnv(env, harness?.env ?? {}),
    };
    save.mutate(body, {
      onSuccess: () => setOpen(false),
      onError: (err) => toast.error(err.message),
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (v) reset();
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{harness ? `Edit ${harness.name}` : "Add a custom harness"}</DialogTitle>
            <DialogDescription>
              Any command that speaks ACP over stdio. Changes apply to agents using it next session.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div>
              <Label className="mb-1.5 block" htmlFor="harness-name">
                Name
              </Label>
              <Input id="harness-name" required value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div>
              <Label className="mb-1.5 block" htmlFor="harness-command">
                Command
              </Label>
              <Input
                id="harness-command"
                required
                placeholder="/usr/local/bin/my-acp-agent"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
              />
            </div>
            <div>
              <Label className="mb-1.5 block" htmlFor="harness-args">
                Arguments (one per line)
              </Label>
              <Textarea id="harness-args" rows={3} value={args} onChange={(e) => setArgs(e.target.value)} />
            </div>
            <div>
              <Label className="mb-1.5 block" htmlFor="harness-env">
                Environment (KEY=value, one per line; saved values stay hidden, leave them empty to keep them)
              </Label>
              <Textarea id="harness-env" rows={3} value={env} onChange={(e) => setEnv(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="ghost">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={save.isPending}>
              {harness ? "Save" : "Add harness"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

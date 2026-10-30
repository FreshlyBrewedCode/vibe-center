import type { Harness, HarnessBody } from "@vibe-center/shared";
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
import { rowsOf, type SecretRow, SecretRows, secretRowsToInput } from "./mcp/secret-rows";

function parseArgs(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

function toLines(args: string[]): string {
  return args.join("\n");
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
  const [env, setEnv] = useState<SecretRow[]>(rowsOf(harness?.env));

  const reset = () => {
    setName(harness?.name ?? "");
    setCommand(harness?.command ?? "");
    setArgs(toLines(harness?.args ?? []));
    setEnv(rowsOf(harness?.env));
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const body: HarnessBody = { name, command, args: parseArgs(args), env: secretRowsToInput(env) };
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
            <SecretRows label="Environment" rows={env} onChange={setEnv} keyPlaceholder="API_KEY" />
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

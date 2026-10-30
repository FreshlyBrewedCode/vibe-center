import { MCP_OAUTH_REDIRECT_PATH, type McpServerBody, type McpServerView } from "@vibe-center/shared";
import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useSaveMcpServer } from "@/lib/queries";
import { rowsOf, type SecretRow, SecretRows, secretRowsToInput } from "./secret-rows";

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
  const [clientId, setClientId] = useState(server?.oauth?.clientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [scopes, setScopes] = useState(server?.oauth?.scopes ?? "");
  const storedSecret = server?.oauth?.clientSecret ?? null;

  const oauthBody = (): McpServerBody["oauth"] => {
    const id = clientId.trim() || null;
    const sc = scopes.trim() || null;
    if (!id && !sc) return null;
    const secret = !id ? null : clientSecret ? clientSecret : storedSecret ? { keep: true as const } : null;
    return { clientId: id, clientSecret: secret, scopes: sc };
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const body: McpServerBody = {
      name: name.trim(),
      transport,
      command: transport === "stdio" ? command.trim() || null : null,
      args: transport === "stdio" ? args.split("\n").filter((a) => a.trim() !== "") : [],
      cwd: transport === "stdio" ? cwd.trim() || null : null,
      url: transport === "http" ? url.trim() || null : null,
      env: transport === "stdio" ? secretRowsToInput(env) : {},
      headers: transport === "http" ? secretRowsToInput(headers) : {},
      oauth: transport === "http" ? oauthBody() : null,
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
              <details className="group" open={!!(server?.oauth?.clientId || server?.oauth?.scopes)}>
                <summary className="flex cursor-pointer list-none items-center gap-1 font-medium text-sm [&::-webkit-details-marker]:hidden">
                  <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />
                  OAuth (advanced)
                </summary>
                <div className="mt-2 space-y-3">
                  <p className="text-muted-foreground text-xs">
                    Servers that ask for OAuth get a Sign in button; the app registers itself with their
                    authorization server. For one without dynamic registration, register a client there with
                    the redirect URI{" "}
                    <code className="break-all font-mono">{`${location.origin}${MCP_OAUTH_REDIRECT_PATH}`}</code>{" "}
                    and enter it here. Leave out an Authorization header to use OAuth.
                  </p>
                  <Label className="block space-y-1.5">
                    <span>Client ID</span>
                    <Input
                      value={clientId}
                      autoComplete="off"
                      placeholder="dynamic registration"
                      onChange={(e) => setClientId(e.target.value)}
                    />
                  </Label>
                  <Label className="block space-y-1.5">
                    <span>Client secret</span>
                    <Input
                      type="password"
                      autoComplete="off"
                      value={clientSecret}
                      disabled={!clientId.trim()}
                      placeholder={
                        storedSecret
                          ? `unchanged${storedSecret.hint ? ` (…${storedSecret.hint})` : ""}`
                          : "none (public client)"
                      }
                      onChange={(e) => setClientSecret(e.target.value)}
                    />
                  </Label>
                  <Label className="block space-y-1.5">
                    <span>Scopes</span>
                    <Input
                      value={scopes}
                      placeholder="the server's choice"
                      onChange={(e) => setScopes(e.target.value)}
                    />
                  </Label>
                </div>
              </details>
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

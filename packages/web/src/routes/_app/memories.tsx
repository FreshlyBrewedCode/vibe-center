import { createFileRoute, useNavigate } from "@tanstack/react-router";
import type { AgentView, Memory } from "@vibe-center/shared";
import { Pencil, Plus, Search, Trash2, Users } from "lucide-react";
import { useDeferredValue, useState } from "react";
import { toast } from "sonner";
import { AgentAvatar } from "@/components/agent-avatar";
import { PageHeader } from "@/components/mobile-nav";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useAgents, useDeleteMemory, useMemories, useSaveMemory } from "@/lib/queries";

const ALL = "__all__";
const SHARED = "shared";

/** `?scope=<agent id>|shared` filters; agents save memories with their memory tools. */
export const Route = createFileRoute("/_app/memories")({
  component: Memories,
  validateSearch: (s: Record<string, unknown>): { scope?: string } =>
    typeof s.scope === "string" && s.scope ? { scope: s.scope } : {},
});

function Memories() {
  const { scope = "" } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const agents = useAgents();
  const [q, setQ] = useState("");
  const query = useDeferredValue(q);
  const memories = useMemories(scope, query);
  const [adding, setAdding] = useState(false);
  const byId = new Map(agents.data?.map((a) => [a.id, a]));

  return (
    <div className="vc-scroll flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl">
        <PageHeader
          title="Memories"
          description="What agents remember across sessions, saved with their memory tools. Each agent sees its own memories and the shared ones."
        />
        <div className="space-y-4 px-3 pb-6 sm:px-8">
          <div className="flex flex-wrap gap-2">
            <Select
              value={scope || ALL}
              onValueChange={(v) => navigate({ search: v === ALL ? {} : { scope: v } })}
            >
              <SelectTrigger aria-label="Whose memories" className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All memories</SelectItem>
                <SelectItem value={SHARED}>Shared</SelectItem>
                {agents.data?.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.avatar.emoji} {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="relative min-w-48 flex-1">
              <Search className="absolute top-2.5 left-3 size-4 text-muted-foreground" />
              <Input
                aria-label="Search memories"
                placeholder="Search"
                className="pl-9"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
            <Button onClick={() => setAdding(true)} disabled={adding}>
              <Plus className="size-4" /> Add
            </Button>
          </div>
          {adding && (
            <MemoryEditor
              initial={{ content: "", tags: [], agentId: scope && scope !== SHARED ? scope : null }}
              agents={agents.data ?? []}
              onDone={() => setAdding(false)}
            />
          )}
          <ul className="space-y-2" data-testid="memories">
            {memories.data?.map((m) => (
              <MemoryItem
                key={m.id}
                memory={m}
                owner={m.agentId ? byId.get(m.agentId) : undefined}
                agents={agents.data ?? []}
              />
            ))}
          </ul>
          {memories.data?.length === 0 && (
            <p className="rounded-xl border border-line border-dashed p-6 text-center text-muted-foreground text-sm">
              {query
                ? "No memories match."
                : "No memories yet. Agents save them as they learn things about you."}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function MemoryItem({
  memory: m,
  owner,
  agents,
}: {
  memory: Memory;
  owner?: AgentView;
  agents: AgentView[];
}) {
  const del = useDeleteMemory();
  const [editing, setEditing] = useState(false);
  if (editing) return <MemoryEditor id={m.id} initial={m} agents={agents} onDone={() => setEditing(false)} />;
  return (
    <li data-testid="memory" className="group space-y-2 rounded-xl border border-line bg-card p-4">
      <p className="whitespace-pre-wrap text-sm leading-[1.55]">{m.content}</p>
      <div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
        {owner ? (
          <span className="flex items-center gap-1.5">
            <AgentAvatar avatar={owner.avatar} size={18} /> {owner.name}
          </span>
        ) : (
          <span className="flex items-center gap-1.5">
            <Users className="size-3.5" /> Shared
          </span>
        )}
        {m.tags.map((t) => (
          <Badge key={t} variant="outline">
            {t}
          </Badge>
        ))}
        <time className="tabular-nums">
          {new Date(m.updatedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}
        </time>
        <span className="flex-1" />
        <Button size="icon-sm" variant="quiet" aria-label="Edit memory" onClick={() => setEditing(true)}>
          <Pencil className="size-3.5" />
        </Button>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button size="icon-sm" variant="quiet" aria-label="Delete memory">
              <Trash2 className="size-3.5" />
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete this memory?</AlertDialogTitle>
              <AlertDialogDescription>This can't be undone.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => del.mutate(m.id, { onError: (e) => toast.error(e.message) })}>
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </li>
  );
}

function MemoryEditor({
  id,
  initial,
  agents,
  onDone,
}: {
  id?: string;
  initial: Pick<Memory, "content" | "tags" | "agentId">;
  agents: AgentView[];
  onDone: () => void;
}) {
  const save = useSaveMemory();
  const [content, setContent] = useState(initial.content);
  const [tags, setTags] = useState(initial.tags.join(", "));
  const [owner, setOwner] = useState(initial.agentId ?? SHARED);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const body = {
      content,
      tags: tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
      agentId: owner === SHARED ? null : owner,
    };
    save.mutate({ id, body }, { onSuccess: onDone, onError: (err) => toast.error(err.message) });
  };
  return (
    <form onSubmit={submit} className="space-y-3 rounded-xl border border-line-strong bg-card p-4">
      <Textarea
        aria-label="Memory"
        required
        rows={3}
        value={content}
        placeholder="A fact worth remembering"
        onChange={(e) => setContent(e.target.value)}
      />
      <div className="flex flex-wrap gap-2">
        <Select value={owner} onValueChange={setOwner}>
          <SelectTrigger aria-label="Owner" className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={SHARED}>Shared</SelectItem>
            {agents.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.avatar.emoji} {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          aria-label="Tags"
          className="min-w-40 flex-1"
          placeholder="tags, comma separated"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
        />
        <Button type="submit" disabled={save.isPending}>
          Save
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

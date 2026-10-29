import { useNavigate, useRouterState } from "@tanstack/react-router";
import type { MessageSearchHit } from "@vibe-center/shared";
import { Bot, MessageSquare, Moon, Plus, Settings, SquarePen, Sun, SunMoon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { setPaletteOpen, usePaletteOpen } from "@/lib/palette";
import { searchMessages, useAgents, useNewSession } from "@/lib/queries";
import { setTheme, type Theme, useTheme } from "@/lib/theme";
import { AgentAvatar } from "./agent-avatar";

const THEME_ORDER: Theme[] = ["light", "dark", "system"];
const THEME_ICON = { light: Sun, dark: Moon, system: SunMoon };

/** Renders a search snippet's `<mark>` spans without `dangerouslySetInnerHTML`: message text
 * can contain anything (including literal HTML an agent echoed from a tool call), so only the
 * `<mark>` boundaries are special-cased; everything else stays plain text React escapes. */
function renderSnippet(snippet: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const re = /<mark>(.*?)<\/mark>/gs;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
  while ((m = re.exec(snippet))) {
    if (m.index > last) parts.push(snippet.slice(last, m.index));
    parts.push(<mark key={i++}>{m[1]}</mark>);
    last = m.index + m[0].length;
  }
  if (last < snippet.length) parts.push(snippet.slice(last));
  return parts;
}

/** ⌘K: switch agents, run quick actions, and search all DMs with jump-to-message. */
export function CommandPalette() {
  const open = usePaletteOpen();
  const navigate = useNavigate();
  const agents = useAgents();
  const theme = useTheme();
  const agentId = useRouterState({ select: (s) => /^\/agents\/([^/]+)/.exec(s.location.pathname)?.[1] });
  const newSession = useNewSession(agents.data?.find((a) => a.id === agentId)?.conversationId ?? "");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<MessageSearchHit[]>([]);
  const seq = useRef(0);

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setHits([]);
      return;
    }
    const mine = ++seq.current;
    const timer = setTimeout(() => {
      searchMessages(q).then((results) => {
        if (seq.current === mine) setHits(results);
      });
    }, 200);
    return () => clearTimeout(timer);
  }, [query]);

  const close = () => setPaletteOpen(false);
  const go = (to: string, params?: Record<string, string>, search?: Record<string, unknown>) => {
    close();
    navigate({ to, params, search } as never);
  };

  const needle = query.trim().toLowerCase();
  const matchingAgents = (agents.data ?? []).filter((a) => a.name.toLowerCase().includes(needle));

  return (
    <CommandDialog
      open={open}
      onOpenChange={setPaletteOpen}
      shouldFilter={false}
      title="Command palette"
      description="Switch agents, run actions, or search every DM"
    >
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder="Switch agents, run a command, or search messages…"
      />
      <CommandList>
        <CommandEmpty>Nothing found.</CommandEmpty>
        {matchingAgents.length > 0 && (
          <CommandGroup heading="Agents">
            {matchingAgents.map((a) => (
              <CommandItem key={a.id} value={a.id} onSelect={() => go("/agents/$agentId", { agentId: a.id })}>
                <AgentAvatar avatar={a.avatar} size="sm" />
                {a.name}
                {a.unread > 0 && (
                  <span className="ml-auto text-muted-foreground text-xs">{a.unread} new</span>
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {!needle && (
          <CommandGroup heading="Actions">
            <CommandItem value="new-agent" onSelect={() => go("/agents/new")}>
              <Plus /> New agent
            </CommandItem>
            {agentId && (
              <CommandItem
                value="new-session"
                onSelect={() => {
                  close();
                  newSession.mutate();
                }}
              >
                <SquarePen /> New session in this DM
              </CommandItem>
            )}
            <CommandItem value="settings" onSelect={() => go("/settings")}>
              <Settings /> Open settings
            </CommandItem>
            <CommandItem
              value="theme"
              onSelect={() => {
                const next = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length] ?? "light";
                setTheme(next);
              }}
            >
              {(() => {
                const Icon = THEME_ICON[theme];
                return <Icon />;
              })()}
              Theme: {theme} (select to cycle)
            </CommandItem>
          </CommandGroup>
        )}
        {hits.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Messages">
              {hits.map((h) => {
                const agent = agents.data?.find((a) => a.id === h.agentId);
                return (
                  <CommandItem
                    key={h.message.id}
                    value={h.message.id}
                    onSelect={() => go("/agents/$agentId", { agentId: h.agentId }, { at: h.message.seq })}
                  >
                    <MessageSquare />
                    <div className="min-w-0 flex-1">
                      <div className="text-muted-foreground text-xs">{agent?.name ?? "Unknown agent"}</div>
                      <div className="truncate">{renderSnippet(h.snippet)}</div>
                    </div>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </>
        )}
        {needle && matchingAgents.length === 0 && hits.length === 0 && (
          <CommandGroup heading="Actions">
            <CommandItem value="new-agent" onSelect={() => go("/agents/new")}>
              <Bot /> New agent named "{query}"
            </CommandItem>
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}

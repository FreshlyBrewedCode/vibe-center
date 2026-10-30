import { useNavigate, useRouterState } from "@tanstack/react-router";
import type { MessageSearchHit } from "@vibe-center/shared";
import { Bot, MessageSquare, Moon, Phone, Plus, Settings, SquarePen, Sun, SunMoon } from "lucide-react";
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
import { searchMessages, useAgents, useNewSession, useVoiceStatus } from "@/lib/queries";
import { setTheme, type Theme, useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { AgentAvatar, statusLine } from "./agent-avatar";
import { Badge } from "./ui/badge";
import { reportFailure } from "./voice/call";
import { startCall } from "./voice/call-client";

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
    parts.push(
      <mark key={i++} className="rounded-[3px] bg-presence-waiting/25 text-foreground">
        {m[1]}
      </mark>,
    );
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
  const voice = useVoiceStatus();
  const agentId = useRouterState({ select: (s) => /^\/agents\/([^/]+)/.exec(s.location.pathname)?.[1] });
  const current = agents.data?.find((a) => a.id === agentId);
  const newSession = useNewSession(current?.conversationId ?? "");
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
  const ThemeIcon = THEME_ICON[theme];

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
            {matchingAgents.map((a) => {
              const s = statusLine(a);
              return (
                <CommandItem
                  key={a.id}
                  value={a.id}
                  onSelect={() => go("/agents/$agentId", { agentId: a.id })}
                >
                  <AgentAvatar avatar={a.avatar} presence={a.presence} size={24} surface="var(--card)" />
                  <span className="font-medium">{a.name}</span>
                  <span className={cn("min-w-0 truncate text-sm", s.className)}>
                    {a.presence === "idle" && a.description ? a.description : s.text}
                  </span>
                  <span className="flex-1" />
                  {a.unread > 0 && (
                    <Badge className="h-[18px] min-w-[18px] px-1.5 text-2xs">{a.unread}</Badge>
                  )}
                </CommandItem>
              );
            })}
          </CommandGroup>
        )}
        {!needle && (
          <CommandGroup heading="Actions">
            {current && voice.data?.worker.state === "ok" && (
              <CommandItem
                value="call"
                onSelect={() => {
                  close();
                  startCall(current.id).catch(reportFailure("start the call"));
                }}
              >
                <Phone /> Call {current.name}
              </CommandItem>
            )}
            <CommandItem value="new-agent" onSelect={() => go("/agents/new")}>
              <Plus /> New agent
            </CommandItem>
            {current && (
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
                const next = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length] ?? "dark";
                setTheme(next);
              }}
            >
              <ThemeIcon />
              Theme: {theme}
              <span className="text-muted-foreground text-xs">select to cycle</span>
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
                    <span className="shrink-0 font-medium">{agent?.name ?? "Unknown agent"}</span>
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">
                      {renderSnippet(h.snippet)}
                    </span>
                    <time className="shrink-0 text-muted-foreground text-xs tabular-nums">
                      {new Date(h.message.createdAt).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </time>
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

import {
  Brain,
  Check,
  ChevronLeft,
  ChevronRight,
  Command,
  CornerDownRight,
  FileCode2,
  Info,
  Loader2,
  Mic,
  Phone,
  PhoneOff,
  Plus,
  Search,
  Settings,
  ShieldAlert,
  Square,
  SquarePen,
  Terminal,
  Volume2,
} from "lucide-react";
import type { ReactNode } from "react";
import {
  AGENTS,
  type Agent,
  CALL,
  CALL_STATE_LABEL,
  DANA,
  MESSAGES,
  type Msg,
  PALETTE_HITS,
  PRESENCE_LABEL,
  ROBIN,
} from "../src/data";
import type { DirectionImpl } from "../src/directions";
import { Avatar, Code, cx, PhoneChrome, ScrollBottom } from "../src/ui";
import "./theme.css";

const ORDER: Agent["presence"][] = ["waiting", "error", "thinking", "working", "in_call", "idle"];
const sorted = [...AGENTS].sort(
  (a, b) =>
    Number(b.unread > 0) - Number(a.unread > 0) || ORDER.indexOf(a.presence) - ORDER.indexOf(b.presence),
);

// ---- desktop ---------------------------------------------------------------------------------

function Desktop({
  call = false,
  details = false,
  palette = false,
}: {
  call?: boolean;
  details?: boolean;
  palette?: boolean;
}) {
  const robin = call ? { ...ROBIN, presence: "in_call" as const, presenceDetail: "In a call" } : ROBIN;
  return (
    <div className="relative flex h-full font-sans text-[14px] text-fg">
      <Sidebar active={robin} />
      <main className="flex min-w-0 flex-1 flex-col bg-bg">
        <Header agent={robin} call={call} />
        {call && <CallStrip />}
        <Messages />
        <Composer />
      </main>
      {details && <Details agent={robin} />}
      {palette && <Palette />}
    </div>
  );
}

function Sidebar({ active }: { active: Agent }) {
  return (
    <nav className="flex w-[260px] shrink-0 flex-col bg-panel text-panel-fg">
      <div className="flex h-[52px] items-center justify-between px-4">
        <span className="font-semibold text-[15px] tracking-tight">Vibe Center</span>
        <span className="size-2 rounded-full bg-ok" title="Live" />
      </div>
      <div className="px-3">
        <button
          type="button"
          className="flex h-8 w-full items-center gap-2 rounded-md bg-white/10 px-2.5 text-[13px] text-panel-fg/80"
        >
          <Search className="size-3.5" />
          <span className="flex-1 text-left">Search</span>
          <kbd className="rounded border border-white/15 px-1 font-mono text-[10px] text-panel-fg/60">⌘K</kbd>
        </button>
      </div>
      <div className="mt-5 flex items-center justify-between px-4 pb-1 text-[11px] text-panel-fg/55 uppercase tracking-wider">
        <span>Agents</span>
        <Plus className="size-3.5" />
      </div>
      <ul className="flex-1 space-y-px px-2">
        {sorted.map((a) => {
          const isActive = a.id === active.id;
          const shown = isActive ? active : a;
          return (
            <li key={a.id}>
              <div
                className={cx(
                  "flex items-center gap-2.5 rounded-md px-2 py-[7px]",
                  isActive ? "bg-white/15" : "hover:bg-white/8",
                )}
              >
                <Avatar
                  agent={a}
                  size={26}
                  radius={7}
                  presence={shown.presence}
                  ringColor={isActive ? "#3f3448" : "var(--panel)"}
                />
                <span className="min-w-0 flex-1">
                  <span
                    className={cx(
                      "block truncate text-[13.5px] leading-tight",
                      a.unread > 0 ? "font-semibold" : "font-medium",
                    )}
                  >
                    {a.name}
                  </span>
                  {shown.presence !== "idle" && (
                    <span className="block truncate text-[11px] text-panel-fg/55 leading-tight">
                      {shown.presenceDetail ?? PRESENCE_LABEL[shown.presence]}
                    </span>
                  )}
                </span>
                {a.unread > 0 && (
                  <span className="rounded-full bg-panel-fg px-1.5 py-px font-semibold text-[10.5px] text-panel">
                    {a.unread}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <div className="space-y-px border-white/10 border-t p-2 text-[13px]">
        <div className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-panel-fg/80">
          <Brain className="size-4" /> Memories
        </div>
        <div className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-panel-fg/80">
          <Settings className="size-4" /> Settings
        </div>
      </div>
    </nav>
  );
}

function Header({ agent, call, mobile = false }: { agent: Agent; call: boolean; mobile?: boolean }) {
  return (
    <header className="flex h-[52px] shrink-0 items-center gap-3 border-line border-b bg-bg px-4">
      {mobile && <ChevronLeft className="-ml-1 size-5 text-muted-fg" />}
      <Avatar agent={agent} size={32} presence={agent.presence} />
      <div className="min-w-0 flex-1 leading-tight">
        <div className="font-semibold text-[15px]">{agent.name}</div>
        <div className="truncate text-[12px] text-muted-fg">
          {call ? (
            <span className="text-call">In a call · {CALL_STATE_LABEL[CALL.state].toLowerCase()}</span>
          ) : (
            (agent.presenceDetail ?? PRESENCE_LABEL[agent.presence])
          )}
        </div>
      </div>
      {!call && (
        <button
          type="button"
          className="flex h-8 items-center gap-1.5 rounded-md border border-line px-2.5 font-medium text-[13px]"
        >
          <Phone className="size-3.5" /> {!mobile && "Call"}
        </button>
      )}
      {!mobile && (
        <button
          type="button"
          className="flex h-8 items-center gap-1.5 rounded-md px-2 text-[13px] text-muted-fg"
        >
          <SquarePen className="size-4" /> New session
        </button>
      )}
      <Info className="size-[18px] text-muted-fg" />
    </header>
  );
}

function CallStrip({ mobile = false }: { mobile?: boolean }) {
  const waiting = CALL.state === "waiting";
  return (
    <div className="shrink-0 border-line border-b bg-muted px-4 py-2">
      <div className="flex items-center gap-3">
        <span
          className={cx("size-2.5 shrink-0 rounded-full", !waiting && "vc-pulse")}
          style={{ background: waiting ? "var(--warn)" : "var(--ok)" }}
        />
        <span className="font-medium text-[13.5px]">{CALL_STATE_LABEL[CALL.state]}</span>
        <span className="font-mono text-[12px] text-muted-fg tabular-nums">{CALL.elapsed}</span>
        {!mobile && (
          <span className="text-[12px] text-muted-fg">
            reply in {CALL.replyMs} s · speech {CALL.speech}
          </span>
        )}
        <span className="flex-1" />
        <button type="button" className="rounded-md p-1.5 text-fg hover:bg-line" aria-label="Mute">
          <Mic className="size-4" />
        </button>
        <button
          type="button"
          className="flex h-7 items-center gap-1.5 rounded-md bg-danger px-2.5 font-medium text-[12.5px] text-white"
        >
          <PhoneOff className="size-3.5" /> Hang up
        </button>
      </div>
      <div className="mt-1.5 space-y-0.5 text-[12.5px]">
        {CALL.transcript.slice(-2).map((t) => (
          <div key={t.text} className="flex gap-1.5">
            <span className="w-10 shrink-0 text-muted-fg">{t.who === "you" ? "You" : ROBIN.name}</span>
            <span className="truncate">{t.text}</span>
          </div>
        ))}
        {waiting && (
          <div className="flex gap-1.5 text-warn">
            <span className="w-10 shrink-0" />
            <span className="flex items-center gap-1">
              <ShieldAlert className="size-3" /> Robin is waiting for you to approve a command
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

// ---- messages --------------------------------------------------------------------------------

function Messages({ mobile = false }: { mobile?: boolean }) {
  let prev: string | null = null;
  return (
    <ScrollBottom className="bg-bg">
      <div className={cx("pb-3", mobile ? "px-3" : "px-5")}>
        {MESSAGES.map((m, i) => {
          const key =
            m.kind === "user" ? "user" : m.kind === "relay" ? "dana" : m.kind === "session" ? "s" : "robin";
          const showHeader = key !== prev;
          prev = key;
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: static mock
            <Row key={i} m={m} showHeader={showHeader} mobile={mobile} />
          );
        })}
      </div>
    </ScrollBottom>
  );
}

function Row({ m, showHeader, mobile }: { m: Msg; showHeader: boolean; mobile: boolean }) {
  if (m.kind === "session") {
    return (
      <div className="flex items-center gap-3 py-4 text-[11.5px] text-muted-fg">
        <span className="h-px flex-1 bg-line" />
        <span className="rounded-full border border-line px-2.5 py-0.5">{m.label}</span>
        <span className="h-px flex-1 bg-line" />
      </div>
    );
  }
  const isUser = m.kind === "user";
  const sender = m.kind === "relay" ? m.from : isUser ? null : ROBIN;
  const name = m.kind === "relay" ? DANA.name : isUser ? "You" : ROBIN.name;
  const voice = (m.kind === "user" || m.kind === "agent") && m.voice;
  return (
    <div className={cx("flex gap-3", showHeader ? "mt-4" : "mt-1", mobile && "gap-2.5")}>
      <div className="w-9 shrink-0">
        {showHeader &&
          (sender ? (
            <Avatar agent={sender} size={36} />
          ) : (
            <span className="inline-flex size-9 items-center justify-center rounded-lg bg-muted font-semibold text-[13px] text-muted-fg">
              K
            </span>
          ))}
      </div>
      <div className="min-w-0 flex-1">
        {showHeader && (
          <div className="mb-0.5 flex items-baseline gap-2 leading-tight">
            <span className="font-semibold text-[14px]">{name}</span>
            {m.kind === "relay" && (
              <span className="flex items-center gap-1 text-[12px] text-muted-fg">
                <CornerDownRight className="size-3" /> to {ROBIN.name}
              </span>
            )}
            <span className="text-[11.5px] text-muted-fg">{m.time}</span>
            {voice && (
              <span className="flex items-center gap-1 rounded-full bg-call/10 px-1.5 py-px text-[10.5px] text-call">
                <Volume2 className="size-3" /> voice
              </span>
            )}
          </div>
        )}
        <Body m={m} />
      </div>
    </div>
  );
}

function Body({ m }: { m: Msg }) {
  switch (m.kind) {
    case "user":
      return <p className="text-[14.5px] leading-[1.55]">{m.text}</p>;
    case "relay":
      return (
        <p
          className="rounded-md border-l-2 pl-3 text-[14.5px] leading-[1.55]"
          style={{ borderColor: DANA.color }}
        >
          {m.text}
        </p>
      );
    case "agent":
      return (
        <div className="space-y-2.5">
          {m.blocks.map((b, i) =>
            b.kind === "p" ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: static mock
              <p key={i} className="text-[14.5px] leading-[1.55]">
                {b.text}
                {m.streaming && i === m.blocks.length - 1 && (
                  <span className="ml-0.5 inline-block h-[15px] w-[7px] translate-y-[2px] bg-fg/70 vc-pulse" />
                )}
              </p>
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: static mock
              <div key={i} className="overflow-hidden rounded-lg border border-line bg-muted">
                <div className="flex items-center justify-between border-line border-b px-3 py-1 text-[11px] text-muted-fg">
                  <span className="font-mono">{b.lang}</span>
                  <span>Copy</span>
                </div>
                <Code code={b.code} className="px-3 py-2.5" />
              </div>
            ),
          )}
        </div>
      );
    case "tool":
      return (
        <div className="overflow-hidden rounded-lg border border-line bg-card text-[13px]">
          <div className="flex items-center gap-2 px-3 py-1.5">
            <ChevronRight className={cx("size-3.5 text-muted-fg", m.output && "rotate-90")} />
            {m.title === "Edit" ? (
              <FileCode2 className="size-4 text-muted-fg" />
            ) : (
              <Terminal className="size-4 text-muted-fg" />
            )}
            <span className="font-medium">{m.title}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-muted-fg">{m.detail}</span>
            {m.status === "done" ? (
              <Check className="size-4 text-ok" />
            ) : (
              <Loader2 className="size-4 animate-spin text-muted-fg" />
            )}
          </div>
          {m.output && (
            <Code code={m.output} className="border-line border-t bg-muted px-3 py-2 text-muted-fg" />
          )}
        </div>
      );
    case "permission":
      return (
        <div className="rounded-lg border border-warn/40 bg-warn/8 p-3 text-[13.5px]">
          <div className="flex items-center gap-2 font-medium">
            <ShieldAlert className="size-4 text-warn" />
            {ROBIN.name} wants to run a command
          </div>
          <code className="mt-2 block rounded-md bg-bg px-3 py-2 font-mono text-[12.5px]">{m.command}</code>
          <div className="mt-2.5 flex gap-2">
            <button
              type="button"
              className="h-8 rounded-md bg-accent px-3.5 font-medium text-[13px] text-accent-fg"
            >
              Allow
            </button>
            <button
              type="button"
              className="h-8 rounded-md border border-line bg-bg px-3.5 font-medium text-[13px]"
            >
              Deny
            </button>
            <span className="flex-1" />
            <button type="button" className="text-[12.5px] text-muted-fg">
              Always allow for this session
            </button>
          </div>
        </div>
      );
    default:
      return null;
  }
}

function Composer({ mobile = false }: { mobile?: boolean }) {
  return (
    <div className={cx("shrink-0 bg-bg", mobile ? "px-3 pt-1 pb-7" : "px-5 pt-1 pb-4")}>
      <div className="rounded-xl border border-line bg-card shadow-sm">
        <div className="px-3.5 pt-3 pb-1 text-[14.5px] text-muted-fg">Message Robin</div>
        <div className="flex items-center gap-1 px-2 pb-2">
          <button type="button" className="rounded-md p-1.5 text-muted-fg" aria-label="Attach">
            <Plus className="size-4" />
          </button>
          {!mobile && (
            <span className="ml-1 text-[11.5px] text-muted-fg">Enter to send · ⇧Enter for a new line</span>
          )}
          <span className="flex-1" />
          <button type="button" className="rounded-md p-1.5 text-muted-fg" aria-label="Stop">
            <Square className="size-3.5 fill-current" />
          </button>
          <button type="button" className="rounded-md bg-accent p-1.5 text-accent-fg" aria-label="Send">
            <CornerDownRight className="size-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

function Details({ agent }: { agent: Agent }) {
  return (
    <aside className="flex w-[300px] shrink-0 flex-col border-line border-l bg-bg">
      <div className="flex h-[52px] items-center border-line border-b px-4 font-semibold text-[13px]">
        Details
      </div>
      <div className="flex-1 overflow-hidden px-4 py-4 text-[13px]">
        <div className="flex items-center gap-3">
          <Avatar agent={agent} size={44} radius={12} />
          <div className="leading-tight">
            <div className="font-semibold text-[15px]">{agent.name}</div>
            <div className="text-[12px] text-muted-fg">{agent.description}</div>
          </div>
        </div>
        <Section title="Agent">
          <KV k="Harness" v={agent.harness} />
          <KV k="Model" v={agent.model} mono />
          <KV k="Directory" v="~/src/vibe-center" mono />
        </Section>
        <Section title="Session">
          <KV k="Started" v="Today 09:12" />
          <KV k="Messages" v="10" />
          <KV k="State" v={agent.presenceDetail ?? PRESENCE_LABEL[agent.presence]} />
        </Section>
        <Section title="Tools">
          <KV k="Built-in" v="memory · search · agents" />
          <KV k="GitHub (MCP)" v="12 tools" />
          <KV k="Playwright (MCP)" v="off" muted />
        </Section>
        <Section title="Voice">
          <KV k="Voice" v="Michael" />
          <KV k="Speech" v="GPU · km-pc" />
        </Section>
      </div>
    </aside>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mt-5">
      <div className="mb-1.5 text-[11px] text-muted-fg uppercase tracking-wider">{title}</div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function KV({ k, v, mono, muted }: { k: string; v: string; mono?: boolean; muted?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-muted-fg">{k}</span>
      <span className={cx("truncate", mono && "font-mono text-[12px]", muted && "text-muted-fg")}>{v}</span>
    </div>
  );
}

function Palette() {
  return (
    <div className="absolute inset-0 z-20 bg-black/30 pt-[120px]">
      <div className="mx-auto w-[600px] overflow-hidden rounded-xl bg-card shadow-2xl ring-1 ring-black/10">
        <div className="flex items-center gap-2 border-line border-b px-4 py-3">
          <Search className="size-4 text-muted-fg" />
          <span className="flex-1 text-[15px]">
            sticky
            <span className="ml-px inline-block h-4 w-px translate-y-[3px] bg-fg" />
          </span>
          <kbd className="rounded border border-line px-1.5 font-mono text-[10px] text-muted-fg">esc</kbd>
        </div>
        <div className="max-h-[420px] py-2 text-[13.5px]">
          <div className="px-4 pt-1 pb-1 text-[11px] text-muted-fg uppercase tracking-wider">Agents</div>
          {AGENTS.slice(0, 3).map((a, i) => (
            <div
              key={a.id}
              className={cx("mx-2 flex items-center gap-2.5 rounded-md px-2 py-1.5", i === 0 && "bg-muted")}
            >
              <Avatar agent={a} size={22} radius={6} presence={a.presence} ringColor="var(--card)" />
              <span className="font-medium">{a.name}</span>
              <span className="text-[12px] text-muted-fg">{a.description}</span>
              <span className="flex-1" />
              {i === 0 && <kbd className="font-mono text-[10px] text-muted-fg">↵</kbd>}
            </div>
          ))}
          <div className="px-4 pt-3 pb-1 text-[11px] text-muted-fg uppercase tracking-wider">Actions</div>
          {[
            [Phone, "Start a call with Robin"],
            [SquarePen, "New session with Robin"],
            [Plus, "New agent"],
          ].map(([Icon, label]) => {
            const I = Icon as typeof Phone;
            return (
              <div key={label as string} className="mx-2 flex items-center gap-2.5 rounded-md px-2 py-1.5">
                <I className="size-4 text-muted-fg" />
                <span>{label as string}</span>
              </div>
            );
          })}
          <div className="px-4 pt-3 pb-1 text-[11px] text-muted-fg uppercase tracking-wider">Messages</div>
          {PALETTE_HITS.map((h) => (
            <div key={h.snippet} className="mx-2 flex items-center gap-2.5 rounded-md px-2 py-1.5">
              <Command className="size-4 text-muted-fg" />
              <span className="font-medium">{h.agent}</span>
              <span className="min-w-0 flex-1 truncate text-muted-fg">
                {h.snippet.split("sticky").map((part, i, arr) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: static mock
                  <span key={i}>
                    {part}
                    {i < arr.length - 1 && <mark className="rounded bg-warn/30 px-0.5 text-fg">sticky</mark>}
                  </span>
                ))}
              </span>
              <span className="text-[11.5px] text-muted-fg">{h.time}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---- mobile ----------------------------------------------------------------------------------

function Mobile() {
  const robin = { ...ROBIN, presence: "in_call" as const };
  return (
    <PhoneChrome>
      <div className="flex h-full flex-col bg-bg font-sans text-fg">
        <Header agent={robin} call mobile />
        <CallStrip mobile />
        <Messages mobile />
        <Composer mobile />
      </div>
    </PhoneChrome>
  );
}

const impl: DirectionImpl = {
  rootClass: "dir-workspace",
  screens: {
    "desktop-dm": () => <Desktop details />,
    "desktop-call": () => <Desktop call />,
    "mobile-call": Mobile,
    extra: () => <Desktop palette />,
  },
};
export default impl;

export const workspaceDark: DirectionImpl = { ...impl, rootClass: "dir-workspace dark" };

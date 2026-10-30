import {
  Activity,
  Brain,
  Check,
  ChevronLeft,
  Mic,
  Phone,
  PhoneOff,
  Plus,
  Search,
  Settings,
  SquarePen,
} from "lucide-react";
import {
  AGENTS,
  type Agent,
  CALL,
  CALL_STATE_LABEL,
  DANA,
  MESSAGES,
  type Msg,
  PRESENCE_LABEL,
  ROBIN,
} from "../src/data";
import type { DirectionImpl } from "../src/directions";
import { Avatar, Code, cx, PhoneChrome, PRESENCE_COLOR, ScrollBottom } from "../src/ui";
import "./theme.css";

const ACTIVITY: Record<string, number[]> = {
  robin: [2, 5, 3, 7, 6, 8, 4, 9, 7, 3, 6, 8],
  dana: [1, 1, 2, 1, 3, 2, 1, 2, 4, 2, 1, 3],
  max: [4, 6, 5, 7, 8, 6, 9, 7, 8, 6, 7, 9],
  sage: [0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
  juno: [3, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
};

function Spark({ id, color }: { id: string; color: string }) {
  const v = ACTIVITY[id] ?? [];
  return (
    <span className="inline-flex h-3.5 items-end gap-px">
      {v.map((n, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: static bars
          key={i}
          className="w-[3px] rounded-[1px]"
          style={{ height: `${Math.max(10, n * 11)}%`, background: color, opacity: 0.85 }}
        />
      ))}
    </span>
  );
}

function Tag({
  children,
  color,
  className,
}: {
  children: React.ReactNode;
  color?: string;
  className?: string;
}) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded-[3px] px-1.5 py-px font-mono text-[10.5px] uppercase tracking-wide",
        className,
      )}
      style={
        color
          ? { color, background: `color-mix(in oklab, ${color} 14%, transparent)` }
          : { background: "var(--muted)", color: "var(--muted-fg)" }
      }
    >
      {children}
    </span>
  );
}

// ---- desktop ---------------------------------------------------------------------------------

function Desktop({ call = false }: { call?: boolean }) {
  const robin = call ? { ...ROBIN, presence: "in_call" as const, presenceDetail: "In a call" } : ROBIN;
  return (
    <div className="flex h-full flex-col bg-bg font-sans text-[13px] text-fg">
      <TopBar />
      <div className="flex min-h-0 flex-1">
        <Board active={robin} />
        <main className="flex min-w-0 flex-1 flex-col">
          <Header agent={robin} call={call} />
          {call && <Strip />}
          <Log />
          <Composer />
        </main>
        <Inspector agent={robin} call={call} />
      </div>
    </div>
  );
}

function TopBar() {
  return (
    <div className="flex h-9 shrink-0 items-center gap-4 border-line border-b bg-panel px-3 font-mono text-[11.5px] text-muted-fg">
      <span className="font-semibold text-fg tracking-tight">VIBE CENTER</span>
      <span className="flex items-center gap-1.5">
        <span className="size-1.5 rounded-full bg-ok" /> live · km-dev
      </span>
      <span>speech gpu/gpu · km-pc</span>
      <span className="flex-1" />
      <span className="flex items-center gap-1.5 rounded border border-line px-2 py-0.5">
        <Search className="size-3" /> search <kbd className="text-muted-fg/70">⌘K</kbd>
      </span>
      <span>09:17:42</span>
    </div>
  );
}

function Board({ active, mobile = false }: { active: Agent; mobile?: boolean }) {
  const busy = AGENTS.filter((a) => a.presence === "thinking" || a.presence === "working").length;
  const waiting =
    AGENTS.filter((a) => a.presence === "waiting").length + (active.presence === "in_call" ? 0 : 0);
  const errors = AGENTS.filter((a) => a.presence === "error").length;
  return (
    <nav
      className={cx(
        "flex shrink-0 flex-col border-line bg-panel",
        mobile ? "w-full" : "h-full w-[300px] border-r",
      )}
    >
      <div className="flex items-center justify-between px-3 pt-3 pb-2 font-mono text-[11px] text-muted-fg">
        <span>
          AGENTS <span className="text-fg">5</span>
        </span>
        <span className="flex gap-2">
          <span className="text-ok">{busy} busy</span>
          <span className="text-warn">{waiting} waiting</span>
          <span className="text-danger">{errors} error</span>
        </span>
      </div>
      <ul className={cx(!mobile && "flex-1")}>
        {AGENTS.map((a) => {
          const isActive = a.id === active.id;
          const shown = isActive ? active : a;
          const color = PRESENCE_COLOR[shown.presence];
          return (
            <li
              key={a.id}
              className={cx(
                "flex items-center gap-2.5 border-line border-b px-3",
                mobile ? "py-3" : "py-2",
                isActive && "bg-muted",
              )}
              style={{ boxShadow: isActive ? "inset 2px 0 0 var(--accent)" : undefined }}
            >
              <Avatar agent={a} size={mobile ? 36 : 28} radius={6} ringColor="var(--panel)" />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className={cx("text-[13px]", a.unread > 0 ? "font-semibold" : "font-medium")}>
                    {a.name}
                  </span>
                  <span className="font-mono text-[10.5px] text-muted-fg">
                    {a.harness === "Claude Code" ? "claude" : "opencode"}
                  </span>
                  {a.unread > 0 && (
                    <span className="rounded-sm bg-accent px-1 font-mono text-[10px] text-accent-fg">
                      {a.unread}
                    </span>
                  )}
                </span>
                <span className="flex items-center gap-1.5 font-mono text-[11px]" style={{ color }}>
                  <span
                    className={cx(
                      "size-1.5 rounded-full",
                      (shown.presence === "working" || shown.presence === "thinking") && "vc-pulse",
                    )}
                    style={{ background: color }}
                  />
                  <span className="truncate">
                    {(shown.presenceDetail ?? PRESENCE_LABEL[shown.presence]).toLowerCase()}
                  </span>
                </span>
              </span>
              <Spark id={a.id} color={shown.presence === "error" ? "var(--danger)" : "var(--muted-fg)"} />
            </li>
          );
        })}
      </ul>
      <div className="flex items-center gap-3 border-line border-t px-3 py-2 font-mono text-[11px] text-muted-fg">
        <span className="flex items-center gap-1.5">
          <Plus className="size-3.5" /> agent
        </span>
        <span className="flex items-center gap-1.5">
          <Brain className="size-3.5" /> memories
        </span>
        <span className="flex items-center gap-1.5">
          <Settings className="size-3.5" /> settings
        </span>
      </div>
    </nav>
  );
}

function Header({ agent, call, mobile = false }: { agent: Agent; call: boolean; mobile?: boolean }) {
  return (
    <header className="flex h-11 shrink-0 items-center gap-3 border-line border-b bg-bg px-3">
      {mobile && <ChevronLeft className="size-5 text-muted-fg" />}
      <Avatar agent={agent} size={24} radius={5} presence={agent.presence} />
      <span className="font-semibold text-[13.5px]">{agent.name}</span>
      <span className="hidden font-mono text-[11px] text-muted-fg sm:inline">
        {agent.model} · ~/src/vibe-center · session #14
      </span>
      <span className="flex-1" />
      {!call && (
        <button
          type="button"
          className="flex h-7 items-center gap-1.5 rounded border border-line px-2 font-mono text-[11px] text-fg"
        >
          <Phone className="size-3" /> CALL
        </button>
      )}
      {!mobile && (
        <button
          type="button"
          className="flex h-7 items-center gap-1.5 rounded border border-line px-2 font-mono text-[11px] text-muted-fg"
        >
          <SquarePen className="size-3" /> NEW SESSION
        </button>
      )}
    </header>
  );
}

function Meter({ level, color }: { level: number; color: string }) {
  return (
    <span className="inline-flex h-3 items-end gap-px">
      {Array.from({ length: 12 }, (_, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: static bars
          key={i}
          className="w-[3px] rounded-[1px]"
          style={{ height: "100%", background: i < level ? color : "var(--line)" }}
        />
      ))}
    </span>
  );
}

function Strip({ mobile = false }: { mobile?: boolean }) {
  const waiting = CALL.state === "waiting";
  const color = waiting ? "var(--warn)" : "var(--ok)";
  return (
    <div className="shrink-0 border-line border-b bg-muted font-mono text-[11.5px]">
      <div className="flex h-10 items-center gap-3 whitespace-nowrap px-3">
        <span className="flex items-center gap-1.5 font-semibold uppercase tracking-wide" style={{ color }}>
          <span className={cx("size-2 rounded-full", !waiting && "vc-pulse")} style={{ background: color }} />
          {mobile ? (waiting ? "waiting" : CALL_STATE_LABEL[CALL.state]) : CALL_STATE_LABEL[CALL.state]}
        </span>
        <span className="text-fg tabular-nums">{CALL.elapsed}</span>
        <span className="flex items-center gap-1.5 text-muted-fg">
          in <Meter level={2} color="var(--ok)" />
        </span>
        {!mobile && (
          <span className="flex items-center gap-1.5 text-muted-fg">
            out <Meter level={0} color="var(--call)" />
          </span>
        )}
        {!mobile && <span className="text-muted-fg">reply {CALL.replyMs}s · stt gpu · tts gpu</span>}
        <span className="flex-1" />
        <button type="button" className="rounded border border-line p-1 text-fg" aria-label="Mute">
          <Mic className="size-3.5" />
        </button>
        <button
          type="button"
          className="flex h-6 items-center gap-1.5 rounded bg-danger px-2 font-semibold text-[11px] text-black uppercase"
          aria-label="Hang up"
        >
          <PhoneOff className="size-3" /> {!mobile && "hang up"}
        </button>
      </div>
      {!mobile && (
        <div className="flex gap-4 border-line border-t px-3 py-1.5 text-muted-fg">
          {CALL.transcript.slice(-2).map((t) => (
            <span key={t.text} className="truncate">
              <span className="text-fg/70">{t.who === "you" ? "you" : "robin"}</span> {t.text}
            </span>
          ))}
          {waiting && <span className="ml-auto text-warn">⚠ approval pending</span>}
        </div>
      )}
      {mobile && waiting && (
        <div className="border-line border-t px-3 py-1 text-warn">
          ⚠ approval pending · say "allow" or tap below
        </div>
      )}
    </div>
  );
}

// ---- log -------------------------------------------------------------------------------------

function Log({ mobile = false }: { mobile?: boolean }) {
  return (
    <ScrollBottom className="bg-bg">
      <div className="pb-2">
        {MESSAGES.map((m, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static mock
          <Row key={i} m={m} mobile={mobile} />
        ))}
      </div>
    </ScrollBottom>
  );
}

function Row({ m, mobile }: { m: Msg; mobile: boolean }) {
  if (m.kind === "session") {
    return (
      <div className="flex items-center gap-2 px-3 py-2 font-mono text-[10.5px] text-muted-fg uppercase tracking-wide">
        <span className="h-px flex-1 bg-line" />
        {m.label}
        <span className="h-px flex-1 bg-line" />
      </div>
    );
  }
  const who =
    m.kind === "user"
      ? "you"
      : m.kind === "relay"
        ? "dana"
        : m.kind === "tool"
          ? "tool"
          : m.kind === "permission"
            ? "ask"
            : "robin";
  const whoColor =
    who === "you"
      ? "var(--accent)"
      : who === "dana"
        ? DANA.color
        : who === "robin"
          ? ROBIN.color
          : who === "ask"
            ? "var(--warn)"
            : "var(--muted-fg)";
  return (
    <div
      className={cx("flex gap-3 px-3 py-1.5 hover:bg-muted/60", m.kind === "permission" && "bg-warn/6")}
      style={m.kind === "permission" ? { boxShadow: "inset 2px 0 0 var(--warn)" } : undefined}
    >
      {!mobile && (
        <span className="w-[42px] shrink-0 pt-[3px] font-mono text-[11px] text-muted-fg tabular-nums">
          {m.time}
        </span>
      )}
      <span
        className="w-[44px] shrink-0 pt-[3px] text-right font-mono text-[11px] font-semibold"
        style={{ color: whoColor }}
      >
        {who}
      </span>
      <div className="min-w-0 flex-1">
        <Body m={m} mobile={mobile} />
      </div>
    </div>
  );
}

function Body({ m, mobile }: { m: Msg; mobile: boolean }) {
  switch (m.kind) {
    case "user":
      return (
        <p className="text-[13.5px] leading-[1.5]">
          {m.voice && (
            <Tag color="var(--call)" className="mr-1.5 align-[1px]">
              voice
            </Tag>
          )}
          {m.text}
        </p>
      );
    case "relay":
      return (
        <p className="text-[13.5px] leading-[1.5]">
          <Tag color={DANA.color} className="mr-1.5 align-[1px]">
            → robin
          </Tag>
          {m.text}
        </p>
      );
    case "agent":
      return (
        <div className="space-y-2">
          {m.blocks.map((b, i) =>
            b.kind === "p" ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: static mock
              <p key={i} className="text-[13.5px] leading-[1.5]">
                {i === 0 && m.voice && (
                  <Tag color="var(--call)" className="mr-1.5 align-[1px]">
                    voice
                  </Tag>
                )}
                {b.text}
                {m.streaming && i === m.blocks.length - 1 && (
                  <span className="ml-0.5 inline-block h-[13px] w-[7px] translate-y-[2px] bg-accent vc-pulse" />
                )}
              </p>
            ) : (
              <Code
                // biome-ignore lint/suspicious/noArrayIndexKey: static mock
                key={i}
                code={b.code}
                className={cx("rounded border border-line bg-card px-3 py-2", mobile && "text-[11px]")}
              />
            ),
          )}
        </div>
      );
    case "tool":
      return (
        <div>
          <div className="flex items-center gap-2 font-mono text-[12px]">
            <Tag>{m.title === "Edit" ? "edit" : "run"}</Tag>
            <span className="truncate text-fg/90">{m.detail}</span>
            <span className="flex items-center gap-1 text-ok">
              <Check className="size-3" /> {m.title === "Edit" ? "0.3s" : "41s"}
            </span>
          </div>
          {m.output && !mobile && (
            <Code
              code={m.output}
              className="mt-1.5 rounded border border-line bg-panel px-3 py-2 text-[11.5px] text-muted-fg"
            />
          )}
          {m.output && mobile && (
            <div className="mt-1 font-mono text-[11px] text-muted-fg">
              48 pass · 0 fail · lint + tsc clean
            </div>
          )}
        </div>
      );
    case "permission":
      return (
        <div>
          <div className="flex items-center gap-2 font-mono text-[12px]">
            <Tag color="var(--warn)">approval</Tag>
            <span className="truncate text-fg">{m.command}</span>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              className="flex h-7 items-center gap-1.5 rounded bg-accent px-3 font-mono text-[11.5px] font-semibold text-accent-fg uppercase"
            >
              allow <kbd className="font-normal opacity-70">⏎</kbd>
            </button>
            <button
              type="button"
              className="flex h-7 items-center gap-1.5 rounded border border-line px-3 font-mono text-[11.5px] font-semibold uppercase"
            >
              deny <kbd className="font-normal opacity-60">esc</kbd>
            </button>
            {!mobile && (
              <span className="font-mono text-[11px] text-muted-fg">always allow for this session: a</span>
            )}
          </div>
        </div>
      );
    default:
      return null;
  }
}

function Composer({ mobile = false }: { mobile?: boolean }) {
  return (
    <div className={cx("shrink-0 border-line border-t bg-panel", mobile ? "px-3 pt-2 pb-8" : "px-3 py-2")}>
      <div className="flex items-center gap-2 rounded border border-line bg-bg px-3 py-2">
        <span className="font-mono text-[13px] text-accent">›</span>
        <span className="flex-1 font-mono text-[13px] text-muted-fg">message robin</span>
        {!mobile && (
          <span className="font-mono text-[10.5px] text-muted-fg">⏎ send · ⇧⏎ newline · ⌃c stop</span>
        )}
        <button type="button" className="rounded border border-line p-1 text-muted-fg" aria-label="Voice">
          <Mic className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

function Inspector({ agent, call }: { agent: Agent; call: boolean }) {
  return (
    <aside className="flex w-[280px] shrink-0 flex-col border-line border-l bg-panel font-mono text-[11.5px]">
      <div className="flex h-11 items-center border-line border-b px-3 text-muted-fg uppercase tracking-wide">
        <Activity className="mr-2 size-3.5" /> inspector
      </div>
      <div className="space-y-4 px-3 py-3">
        <Group title="session #14">
          <Line k="started" v="09:12:04" />
          <Line k="turns" v="4" />
          <Line k="state" v={call ? "in call · waiting" : "waiting approval"} color="var(--warn)" />
          <Line k="last tool" v="run · 41s" />
          <Line k="latency p50" v="1.4s" />
        </Group>
        <Group title="agent">
          <Line k="harness" v="claude-code" />
          <Line k="model" v={agent.model} />
          <Line k="cwd" v="~/src/vibe-center" />
          <Line k="voice" v="am_michael" />
        </Group>
        <Group title="tools · 19 on">
          <Line k="builtin" v="memory 5 · search 2 · agents 2" />
          <Line k="github" v="12" />
          <Line k="playwright" v="off" color="var(--muted-fg)" />
        </Group>
        <Group title="relays">
          <Line k="dana → robin" v="09:16" color={DANA.color} />
          <Line k="robin → dana" v="pending" />
        </Group>
      </div>
    </aside>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-muted-fg uppercase tracking-wide">{title}</div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function Line({ k, v, color }: { k: string; v: string; color?: string }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-muted-fg">{k}</span>
      <span className="truncate" style={{ color: color ?? "var(--fg)" }}>
        {v}
      </span>
    </div>
  );
}

// ---- mobile ----------------------------------------------------------------------------------

function MobileCall() {
  const robin = { ...ROBIN, presence: "in_call" as const };
  return (
    <PhoneChrome dark>
      <div className="flex h-full flex-col bg-bg font-sans text-fg">
        <Header agent={robin} call mobile />
        <Strip mobile />
        <Log mobile />
        <Composer mobile />
      </div>
    </PhoneChrome>
  );
}

function MobileBoard() {
  return (
    <PhoneChrome dark>
      <div className="flex h-full flex-col bg-panel font-sans text-fg">
        <div className="flex h-11 shrink-0 items-center gap-3 border-line border-b px-3 font-mono text-[11.5px] text-muted-fg">
          <span className="font-semibold text-fg">VIBE CENTER</span>
          <span className="flex items-center gap-1.5">
            <span className="size-1.5 rounded-full bg-ok" /> live
          </span>
          <span className="flex-1" />
          <Search className="size-4" />
        </div>
        <Board active={ROBIN} mobile />
        <Feed />
      </div>
    </PhoneChrome>
  );
}

const EVENTS: { time: string; who: string; color: string; text: string }[] = [
  { time: "09:17", who: "robin", color: ROBIN.color, text: "asks approval · git commit -am …" },
  { time: "09:16", who: "dana", color: DANA.color, text: "→ robin · mobile pass today" },
  { time: "09:15", who: "robin", color: ROBIN.color, text: "call · 2 turns · reply 1.4s" },
  { time: "09:13", who: "robin", color: ROBIN.color, text: "run · bun run check ✓ 41s" },
  { time: "08:52", who: "max", color: "#10b981", text: "run · tailscale status ✓" },
  { time: "yday", who: "juno", color: "#ec4899", text: "error · opencode not signed in" },
  { time: "yday", who: "sage", color: "#0ea5e9", text: "memory · saved 3 notes" },
];

/** Cross-agent event feed: the part of the control room the sidebar can't show. */
function Feed() {
  return (
    <div className="min-h-0 flex-1 overflow-hidden bg-bg">
      <div className="px-3 pt-3 pb-1.5 font-mono text-[11px] text-muted-fg uppercase tracking-wide">
        activity
      </div>
      {EVENTS.map((e) => (
        <div key={e.time + e.text} className="flex gap-3 px-3 py-1.5 font-mono text-[12px]">
          <span className="w-10 shrink-0 text-muted-fg tabular-nums">{e.time}</span>
          <span className="w-10 shrink-0 font-semibold" style={{ color: e.color }}>
            {e.who}
          </span>
          <span className="truncate text-fg/85">{e.text}</span>
        </div>
      ))}
    </div>
  );
}

const impl: DirectionImpl = {
  rootClass: "dir-console",
  screens: {
    "desktop-dm": () => <Desktop />,
    "desktop-call": () => <Desktop call />,
    "mobile-call": MobileCall,
    extra: MobileBoard,
  },
};
export default impl;

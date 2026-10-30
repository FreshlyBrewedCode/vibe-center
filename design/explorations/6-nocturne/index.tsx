import {
  ArrowUp,
  AudioLines,
  Brain,
  Check,
  ChevronDown,
  ChevronLeft,
  CornerDownRight,
  FilePen,
  Info,
  MessageSquare,
  Mic,
  MicOff,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Phone,
  PhoneOff,
  Plug,
  Plus,
  Search,
  Settings,
  ShieldAlert,
  SquarePen,
  Terminal,
  Volume2,
} from "lucide-react";
import { createContext, type ReactNode, useContext } from "react";
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
  type Presence,
  ROBIN,
} from "../src/data";
import type { DirectionImpl } from "../src/directions";
import { Avatar, Code, cx, PhoneChrome, PRESENCE_COLOR, ScrollBottom, Wave } from "../src/ui";
import "./theme.css";

/** 6 = "bubbles" (hybrid: bubbles for short turns, full-width for long output); 6b = "rows" (no bubbles). */
type Variant = "bubbles" | "rows";
const VariantCtx = createContext<Variant>("bubbles");
const useVariant = () => useContext(VariantCtx);

const IN_CALL: Agent = { ...ROBIN, presence: "in_call", presenceDetail: "In a call" };

// ---- presence ring ---------------------------------------------------------------------------

/** Avatar with a 2px presence ring offset from the surface. Live states (thinking/working/call/approval)
 *  get a faint glow; idle gets nothing, which keeps the rail quiet. */
function RingAvatar({
  agent,
  size,
  presence = agent.presence,
  surface = "var(--bg)",
  className,
}: {
  agent: Agent;
  size: number;
  presence?: Presence;
  surface?: string;
  className?: string;
}) {
  const color = PRESENCE_COLOR[presence];
  const live = presence !== "idle";
  const glow = presence === "waiting" || presence === "in_call" || presence === "error";
  return (
    <span className={cx("relative inline-flex shrink-0", className)} style={{ width: size, height: size }}>
      {live && (
        <span
          className={cx(
            "absolute rounded-full",
            (presence === "thinking" || presence === "working") && "vc-pulse",
          )}
          style={{
            inset: -4,
            border: `2px solid ${color}`,
            boxShadow: glow
              ? `0 0 0 2px ${surface} inset, 0 0 14px 0 color-mix(in oklab, ${color} 45%, transparent)`
              : `0 0 0 2px ${surface} inset`,
          }}
        />
      )}
      <Avatar agent={agent} size={size} radius={size / 2} className="relative" />
    </span>
  );
}

function UserAvatar({ size = 28 }: { size?: number }) {
  return (
    <span
      className="inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold text-white"
      style={{ width: size, height: size, background: "var(--user-avatar)", fontSize: size * 0.42 }}
    >
      K
    </span>
  );
}

function statusLine(a: Agent): { text: string; color?: string } {
  if (a.presence === "idle") return { text: a.last.text };
  return { text: a.presenceDetail ?? PRESENCE_LABEL[a.presence], color: PRESENCE_COLOR[a.presence] };
}

function Badge({ n, className }: { n: number; className?: string }) {
  return (
    <span
      className={cx(
        "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-accent px-1.5 font-semibold text-[11px] text-accent-fg tabular-nums",
        className,
      )}
    >
      {n}
    </span>
  );
}

function Mark() {
  return (
    <span className="flex size-7 items-center justify-center rounded-[8px] border border-line-strong bg-card font-semibold text-[13px] text-fg tracking-tight">
      V
    </span>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded-[5px] border border-line-strong bg-muted px-1.5 py-px font-sans text-[10.5px] text-muted-fg">
      {children}
    </kbd>
  );
}

// ---- sidebar: collapsed rail or expanded list ------------------------------------------------

function Sidebar({
  active,
  expanded,
  tooltipFor,
}: {
  active: Agent;
  expanded: boolean;
  tooltipFor?: string;
}) {
  const bottom: [typeof Brain, string][] = [
    [Brain, "Memories"],
    [Plug, "MCP servers"],
    [Settings, "Settings"],
  ];
  if (!expanded) {
    return (
      <nav className="relative flex w-[64px] shrink-0 flex-col items-center border-line border-r bg-panel pt-3 pb-3">
        <Mark />
        <span className="my-3 h-px w-8 bg-line" />
        <ul className="flex flex-col items-center gap-1">
          {AGENTS.map((a) => {
            const isActive = a.id === active.id;
            const shown = isActive ? active : a;
            return (
              <li key={a.id} className="relative flex items-center">
                <span
                  className={cx(
                    "absolute -left-2 h-6 w-[3px] rounded-r-full bg-fg transition-opacity",
                    isActive ? "opacity-100" : "opacity-0",
                  )}
                />
                <span
                  className={cx(
                    "relative flex size-12 items-center justify-center rounded-[14px]",
                    isActive && "bg-muted",
                  )}
                >
                  <RingAvatar agent={shown} size={36} surface="var(--panel)" />
                  {a.unread > 0 && (
                    <Badge n={a.unread} className="-top-0.5 -right-0.5 absolute ring-2 ring-panel" />
                  )}
                </span>
                {tooltipFor === a.id && <Tooltip agent={a} />}
              </li>
            );
          })}
        </ul>
        <button
          type="button"
          className="mt-2 flex size-9 items-center justify-center rounded-full border border-line-strong border-dashed text-muted-fg"
          aria-label="New agent"
        >
          <Plus className="size-4" />
        </button>
        <span className="flex-1" />
        <ul className="flex flex-col items-center gap-1 text-muted-fg">
          <li className="flex size-9 items-center justify-center rounded-[10px]">
            <Search className="size-[18px]" />
          </li>
          {bottom.map(([Icon, label]) => (
            <li key={label} className="flex size-9 items-center justify-center rounded-[10px]" title={label}>
              <Icon className="size-[18px]" />
            </li>
          ))}
        </ul>
        <span className="my-3 h-px w-8 bg-line" />
        <UserAvatar size={28} />
        <button
          type="button"
          className="mt-3 flex size-8 items-center justify-center rounded-[8px] text-muted-fg"
          aria-label="Expand sidebar"
        >
          <PanelLeftOpen className="size-4" />
        </button>
      </nav>
    );
  }
  return (
    <nav className="flex w-[272px] shrink-0 flex-col border-line border-r bg-panel">
      <div className="flex h-[56px] items-center gap-2.5 px-4">
        <Mark />
        <span className="flex-1 font-semibold text-[14px] tracking-tight">Vibe Center</span>
        <button type="button" className="text-muted-fg" aria-label="Collapse sidebar">
          <PanelLeftClose className="size-4" />
        </button>
      </div>
      <div className="px-3">
        <div className="flex h-9 items-center gap-2 rounded-[10px] border border-line bg-bg px-3 text-[13px] text-muted-fg">
          <Search className="size-4" />
          <span className="flex-1">Search</span>
          <Kbd>⌘K</Kbd>
        </div>
      </div>
      <div className="mt-4 flex items-center justify-between px-5 pb-1 font-medium text-[11px] text-muted-fg uppercase tracking-[0.08em]">
        <span>Agents</span>
        <SquarePen className="size-3.5" />
      </div>
      <ul className="flex flex-col gap-0.5 px-2">
        {AGENTS.map((a) => {
          const isActive = a.id === active.id;
          const shown = isActive ? active : a;
          const s = statusLine(shown);
          return (
            <li
              key={a.id}
              className={cx("flex items-center gap-3 rounded-[12px] px-2.5 py-2", isActive && "bg-muted")}
            >
              <RingAvatar agent={shown} size={34} surface={isActive ? "var(--muted)" : "var(--panel)"} />
              <span className="min-w-0 flex-1 leading-tight">
                <span className="flex items-baseline justify-between gap-2">
                  <span className={cx("truncate text-[13.5px]", a.unread ? "font-semibold" : "font-medium")}>
                    {a.name}
                  </span>
                  <span className="shrink-0 text-[11px] text-muted-fg tabular-nums">{a.last.time}</span>
                </span>
                <span className="mt-0.5 flex items-center gap-2">
                  <span className="truncate text-[12.5px] text-muted-fg" style={{ color: s.color }}>
                    {s.text}
                  </span>
                  {a.unread > 0 && <Badge n={a.unread} className="ml-auto" />}
                </span>
              </span>
            </li>
          );
        })}
        <li className="flex items-center gap-3 rounded-[12px] px-2.5 py-2 text-[13px] text-muted-fg">
          <span className="flex size-[34px] items-center justify-center rounded-full border border-line-strong border-dashed">
            <Plus className="size-4" />
          </span>
          New agent
        </li>
      </ul>
      <span className="flex-1" />
      <ul className="flex flex-col gap-0.5 px-2 pb-2 text-[13px] text-muted-fg">
        {bottom.map(([Icon, label]) => (
          <li key={label} className="flex h-9 items-center gap-3 rounded-[10px] px-2.5">
            <Icon className="size-4" /> {label}
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-3 border-line border-t px-4 py-3">
        <UserAvatar size={28} />
        <span className="flex-1 leading-tight">
          <span className="block font-medium text-[13px]">Karl</span>
          <span className="block text-[11.5px] text-muted-fg">karl's-macbook · tailnet</span>
        </span>
        <MoreHorizontal className="size-4 text-muted-fg" />
      </div>
    </nav>
  );
}

/** Hover tooltip in the collapsed rail: the name and status the rail hides. */
function Tooltip({ agent }: { agent: Agent }) {
  const s = statusLine(agent);
  return (
    <span className="elev absolute left-[60px] z-20 flex items-center gap-2 whitespace-nowrap rounded-[10px] border border-line-strong bg-card px-3 py-2 text-[12.5px]">
      <span className="font-semibold">{agent.name}</span>
      <span className="text-muted-fg" style={{ color: s.color }}>
        {s.text}
      </span>
      {agent.unread > 0 && <Badge n={agent.unread} />}
    </span>
  );
}

// ---- header ----------------------------------------------------------------------------------

function Header({ agent, call, mobile = false }: { agent: Agent; call: boolean; mobile?: boolean }) {
  const s = statusLine(agent);
  return (
    <header
      className={cx(
        "flex shrink-0 items-center gap-3 border-line border-b bg-bg/90 backdrop-blur",
        mobile ? "h-[56px] px-2" : "h-[56px] px-5",
      )}
    >
      {mobile && (
        <button type="button" className="flex size-10 items-center justify-center text-fg" aria-label="Back">
          <ChevronLeft className="size-6" />
        </button>
      )}
      <RingAvatar agent={agent} size={mobile ? 34 : 32} />
      <span className="min-w-0 flex-1 leading-tight">
        <span className="flex items-center gap-1.5 font-semibold text-[14px]">
          {agent.name}
          {!mobile && <ChevronDown className="size-3.5 text-muted-fg" />}
        </span>
        <span
          className="flex items-center gap-1.5 truncate text-[12px] text-muted-fg"
          style={{ color: s.color }}
        >
          {call ? (
            <>
              <span className="size-1.5 rounded-full bg-call vc-pulse" />
              In a call · <span className="tabular-nums">{CALL.elapsed}</span>
            </>
          ) : (
            s.text
          )}
        </span>
      </span>
      {!mobile && (
        <span className="mr-1 hidden items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-[11.5px] text-muted-fg lg:flex">
          {agent.harness} · {agent.model}
        </span>
      )}
      {!call && (
        <button
          type="button"
          className={cx(
            "flex items-center justify-center gap-1.5 rounded-full font-medium text-[13px]",
            mobile
              ? "size-10 text-fg"
              : "h-9 border border-line-strong bg-card px-3.5 text-fg shadow-[var(--elev-sm)]",
          )}
          aria-label="Call"
        >
          <Phone className="size-4" />
          {!mobile && "Call"}
        </button>
      )}
      <button
        type="button"
        className={cx("flex items-center justify-center text-muted-fg", mobile ? "size-10" : "size-9")}
        aria-label="Details"
      >
        <Info className="size-[18px]" />
      </button>
    </header>
  );
}

// ---- thread ----------------------------------------------------------------------------------

type Row = Msg | { kind: "tools"; items: Extract<Msg, { kind: "tool" }>[] };

/** Consecutive tool calls fold into one activity card, so a run of edits reads as one event. */
function group(messages: Msg[]): Row[] {
  const out: Row[] = [];
  for (const m of messages) {
    const prev = out[out.length - 1];
    if (m.kind === "tool") {
      if (prev?.kind === "tools") prev.items.push(m);
      else out.push({ kind: "tools", items: [m] });
    } else out.push(m);
  }
  return out;
}

const ROWS = group(MESSAGES);

function Thread({ mobile = false }: { mobile?: boolean }) {
  const variant = useVariant();
  return (
    <ScrollBottom>
      <div
        className={cx(
          "mx-auto flex w-full flex-col",
          mobile ? "gap-2.5 px-4 pt-3 pb-3 text-[16px]" : "max-w-[960px] px-10 pt-4 pb-4 text-[14.5px]",
          !mobile && (variant === "rows" ? "gap-5" : "gap-2.5"),
        )}
      >
        {ROWS.map((m, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static mock
          <Turn key={i} m={m} mobile={mobile} />
        ))}
      </div>
    </ScrollBottom>
  );
}

function Spoken({ className }: { className?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-1 text-[11px] text-muted-fg", className)}>
      <AudioLines className="size-3" /> Spoken
    </span>
  );
}

function NameLine({
  avatar,
  name,
  color,
  time,
  voice,
  extra,
}: {
  avatar: ReactNode;
  name: string;
  color?: string;
  time: string;
  voice?: boolean;
  extra?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2.5">
      {avatar}
      <span className="font-semibold text-[13px]" style={{ color }}>
        {name}
      </span>
      <span className="text-[11.5px] text-muted-fg tabular-nums">{time}</span>
      {voice && <Spoken />}
      {extra}
    </div>
  );
}

function Prose({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <p className="max-w-[72ch] leading-[1.55]">
      {text}
      {streaming && (
        <span className="caret ml-0.5 inline-block h-[1em] w-[2px] translate-y-[2px] bg-accent" />
      )}
    </p>
  );
}

function CodeBlock({ code, lang, mobile }: { code: string; lang: string; mobile: boolean }) {
  return (
    <div className="overflow-hidden rounded-[12px] border border-line bg-panel">
      <div className="flex items-center justify-between border-line border-b px-3.5 py-1.5 font-mono text-[11px] text-muted-fg">
        <span>{lang}</span>
        <span>Copy</span>
      </div>
      <Code code={code} className={cx("px-3.5 py-3", mobile ? "text-[11.5px]" : "text-[12.5px]")} />
    </div>
  );
}

function Turn({ m, mobile }: { m: Row; mobile: boolean }) {
  const variant = useVariant();
  const bubbles = variant === "bubbles";
  const indent = mobile ? "pl-[38px]" : "pl-[38px]";
  switch (m.kind) {
    case "session":
      return (
        <div className="flex items-center gap-3 py-2 text-[11.5px] text-muted-fg">
          <span className="h-px flex-1 bg-line" />
          {m.label}
          <span className="h-px flex-1 bg-line" />
        </div>
      );
    case "user":
      if (!bubbles)
        return (
          <div>
            <NameLine avatar={<UserAvatar />} name="You" time={m.time} voice={m.voice} />
            <div className={cx("mt-1", indent)}>
              <Prose text={m.text} />
            </div>
          </div>
        );
      return (
        <div className="flex flex-col items-end gap-1">
          {m.voice && <Spoken className="mr-1" />}
          <div
            className={cx(
              "rounded-[18px] rounded-br-[6px] bg-accent-soft px-4 py-2.5 leading-[1.5]",
              mobile ? "max-w-[85%]" : "max-w-[60%]",
            )}
          >
            {m.text}
          </div>
        </div>
      );
    case "relay":
      return (
        <div>
          <NameLine
            avatar={<Avatar agent={DANA} size={28} radius={14} />}
            name={DANA.name}
            color={DANA.color}
            time={m.time}
            extra={
              <span className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-px text-[11px] text-muted-fg">
                <CornerDownRight className="size-3" /> relay to {ROBIN.name}
              </span>
            }
          />
          <div className={cx("mt-1", indent)}>
            {bubbles ? (
              <div
                className={cx(
                  "rounded-[18px] rounded-tl-[6px] border border-line bg-card px-4 py-2.5 leading-[1.5]",
                  mobile ? "max-w-[92%]" : "max-w-[70%]",
                )}
              >
                {m.text}
              </div>
            ) : (
              <p
                className="max-w-[72ch] leading-[1.55]"
                style={{ borderLeft: `2px solid ${DANA.color}`, paddingLeft: 12 }}
              >
                {m.text}
              </p>
            )}
          </div>
        </div>
      );
    case "agent": {
      const long = m.blocks.length > 1 || m.blocks.some((b) => b.kind === "code");
      if (bubbles && !long) {
        const b = m.blocks[0];
        return (
          <div className="flex items-end gap-2.5">
            <Avatar agent={ROBIN} size={28} radius={14} />
            <div className={cx("flex flex-col gap-1", mobile ? "max-w-[85%]" : "max-w-[70%]")}>
              {m.voice && <Spoken className="ml-1" />}
              <div className="rounded-[18px] rounded-bl-[6px] border border-line bg-card px-4 py-2.5 leading-[1.5]">
                {b?.kind === "p" && <Prose text={b.text} streaming={m.streaming} />}
              </div>
            </div>
          </div>
        );
      }
      return (
        <div>
          <NameLine
            avatar={<Avatar agent={ROBIN} size={28} radius={14} />}
            name={ROBIN.name}
            time={m.time}
            voice={m.voice}
          />
          <div className={cx("mt-1.5 flex flex-col gap-3", indent)}>
            {m.blocks.map((b, i) =>
              b.kind === "p" ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: static mock
                <Prose key={i} text={b.text} streaming={m.streaming && i === m.blocks.length - 1} />
              ) : (
                // biome-ignore lint/suspicious/noArrayIndexKey: static mock
                <CodeBlock key={i} code={b.code} lang={b.lang} mobile={mobile} />
              ),
            )}
          </div>
        </div>
      );
    }
    case "tools":
      return (
        <div className={cx("flex flex-col", indent, bubbles && !mobile && "-mt-1")}>
          <div className="w-fit max-w-full divide-y divide-line overflow-hidden rounded-[12px] border border-line bg-card text-[12.5px]">
            {m.items.map((t) => (
              <div key={t.detail} className="flex h-9 items-center gap-2.5 pr-3 pl-3">
                {t.title === "Edit" ? (
                  <FilePen className="size-3.5 text-muted-fg" />
                ) : (
                  <Terminal className="size-3.5 text-muted-fg" />
                )}
                <span className="font-medium">{t.title === "Edit" ? "Edited" : "Ran"}</span>
                <span
                  className={cx("truncate font-mono text-[12px] text-muted-fg", mobile && "max-w-[170px]")}
                >
                  {t.title === "Edit" ? "…/agents/$agentId/index.tsx" : t.detail}
                </span>
                <Check className="size-3.5 text-ok" />
                {t.output && !mobile && <span className="text-muted-fg">48 tests pass</span>}
                <ChevronDown className="size-3.5 text-muted-fg" />
              </div>
            ))}
          </div>
        </div>
      );
    case "permission":
      return (
        <div className={indent}>
          <Approval command={m.command} mobile={mobile} />
        </div>
      );
    default:
      return null;
  }
}

function Approval({
  command,
  mobile,
  compact = false,
}: {
  command: string;
  mobile: boolean;
  compact?: boolean;
}) {
  return (
    <div
      className={cx(
        "overflow-hidden rounded-[14px] border bg-card",
        compact ? "w-full border-line" : mobile ? "w-full border-warn/40" : "w-[520px] border-warn/40",
      )}
      style={
        compact ? undefined : { boxShadow: "0 0 0 3px color-mix(in oklab, var(--warn) 10%, transparent)" }
      }
    >
      <div className={cx("flex items-center gap-2 text-[13px]", compact ? "px-3.5 pt-3" : "px-4 pt-3.5")}>
        <ShieldAlert className="size-4 text-warn" />
        <span className="font-semibold">Robin wants to run</span>
        {!mobile && !compact && (
          <span className="ml-auto flex items-center gap-1.5 text-[11px] text-muted-fg">
            <Kbd>⏎</Kbd> allow <Kbd>esc</Kbd> deny
          </span>
        )}
      </div>
      <code
        className={cx(
          "mt-2.5 block rounded-[8px] bg-bg px-3 py-2 font-mono text-[12.5px] leading-snug",
          compact ? "mx-3.5" : "mx-4",
        )}
      >
        {command}
      </code>
      <div className={cx("flex gap-2", compact ? "p-3.5" : "p-4")}>
        <button
          type="button"
          className="flex h-9 flex-1 items-center justify-center rounded-[10px] bg-accent font-semibold text-[13.5px] text-accent-fg"
        >
          Allow
        </button>
        <button
          type="button"
          className="flex h-9 flex-1 items-center justify-center rounded-[10px] border border-line-strong font-medium text-[13.5px]"
        >
          Deny
        </button>
      </div>
    </div>
  );
}

function Composer({ mobile = false }: { mobile?: boolean }) {
  return (
    <div className={cx("shrink-0", mobile ? "px-3 pt-2 pb-[30px]" : "px-10 pt-2 pb-5")}>
      <div
        className={cx(
          "mx-auto flex w-full max-w-[960px] items-end gap-2 rounded-[16px] border border-line-strong bg-card",
          mobile ? "p-1.5" : "p-2",
        )}
        style={{ boxShadow: "var(--elev-sm)" }}
      >
        <button
          type="button"
          className="flex size-9 shrink-0 items-center justify-center rounded-[10px] text-muted-fg"
          aria-label="Attach"
        >
          <Plus className="size-5" />
        </button>
        <span
          className={cx(
            "flex min-h-9 flex-1 items-center text-muted-fg",
            mobile ? "text-[16px]" : "text-[14.5px]",
          )}
        >
          Message {ROBIN.name}…
        </span>
        <button
          type="button"
          className="flex size-9 shrink-0 items-center justify-center rounded-[10px] text-muted-fg"
          aria-label="Voice"
        >
          <Mic className="size-[18px]" />
        </button>
        <button
          type="button"
          className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-accent text-accent-fg"
          aria-label="Send"
        >
          <ArrowUp className="size-[18px]" />
        </button>
      </div>
      {!mobile && (
        <p className="mx-auto mt-2 max-w-[960px] px-1 text-[11px] text-muted-fg">
          <Kbd>⏎</Kbd> send · <Kbd>⇧⏎</Kbd> newline · <Kbd>⌘K</Kbd> jump
        </p>
      )}
    </div>
  );
}

// ---- call: floating card (desktop), strip + sheet (mobile) ----------------------------------

function CallCard() {
  const waiting = CALL.state === "waiting";
  return (
    <div className="elev absolute top-[68px] right-5 z-20 w-[320px] overflow-hidden rounded-[20px] border border-line-strong bg-card">
      <div className="flex items-center gap-3 px-4 pt-4">
        <RingAvatar
          agent={ROBIN}
          size={44}
          presence={waiting ? "waiting" : "in_call"}
          surface="var(--card)"
        />
        <span className="min-w-0 flex-1 leading-tight">
          <span className="flex items-center justify-between font-semibold text-[15px]">
            {ROBIN.name}
            <span className="font-normal text-[12.5px] text-muted-fg tabular-nums">{CALL.elapsed}</span>
          </span>
          <span
            className={cx(
              "mt-1 inline-flex items-center gap-1.5 font-medium text-[12.5px]",
              waiting ? "text-warn" : "text-call",
            )}
          >
            {waiting ? <ShieldAlert className="size-3.5" /> : <Wave color="currentColor" height={12} />}
            {CALL_STATE_LABEL[CALL.state]}
          </span>
        </span>
      </div>
      <div className="mt-3 space-y-1 px-4 text-[12.5px]">
        {CALL.transcript.slice(-2).map((t) => (
          <p key={t.text} className={cx("truncate", t.who === "you" ? "text-muted-fg" : "text-fg")}>
            <span className="mr-1.5 text-muted-fg">{t.who === "you" ? "You" : ROBIN.name}</span>
            {t.text}
          </p>
        ))}
      </div>
      {waiting && (
        <div className="mt-3 border-line border-t bg-bg/40">
          <Approval command={'git commit -am "web: keep the DM header sticky on mobile"'} mobile compact />
        </div>
      )}
      <div className="flex items-center justify-center gap-3 border-line border-t px-4 py-3">
        {[
          [MicOff, "Mute", "bg-muted text-fg"],
          [Volume2, "Speaker", "bg-muted text-fg"],
          [MessageSquare, "Hide", "bg-muted text-fg"],
          [PhoneOff, "Hang up", "bg-danger text-white"],
        ].map(([Icon, label, bg]) => {
          const I = Icon as typeof Mic;
          return (
            <button
              key={label as string}
              type="button"
              className={cx("flex size-10 items-center justify-center rounded-full", bg as string)}
              aria-label={label as string}
            >
              <I className="size-[18px]" />
            </button>
          );
        })}
      </div>
    </div>
  );
}

function CallStrip() {
  const waiting = CALL.state === "waiting";
  return (
    <div className="shrink-0 border-line border-b px-3 pt-2 pb-2">
      <div
        className="flex items-center gap-3 rounded-[14px] border border-line-strong bg-card py-2 pr-2 pl-3"
        style={{ boxShadow: "var(--elev-sm)" }}
      >
        <span
          className={cx(
            "flex size-8 items-center justify-center rounded-full",
            waiting ? "bg-warn/15 text-warn" : "bg-call/15 text-call",
          )}
        >
          {waiting ? <ShieldAlert className="size-4" /> : <Wave color="currentColor" height={14} />}
        </span>
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block font-semibold text-[14px]">
            {waiting ? "Waiting for your approval" : CALL_STATE_LABEL[CALL.state]}
          </span>
          <span className="block text-[12px] text-muted-fg">
            <span className="tabular-nums">{CALL.elapsed}</span> · Tap to open the call
          </span>
        </span>
        <button
          type="button"
          className="flex size-10 items-center justify-center rounded-full bg-muted"
          aria-label="Mute"
        >
          <Mic className="size-4" />
        </button>
        <button
          type="button"
          className="flex size-10 items-center justify-center rounded-full bg-danger text-white"
          aria-label="Hang up"
        >
          <PhoneOff className="size-4" />
        </button>
      </div>
    </div>
  );
}

function CallSheet() {
  const waiting = CALL.state === "waiting";
  return (
    <div className="h-full bg-bg">
      <PhoneChrome dark>
        <div className="relative flex h-full flex-col items-center px-5 font-sans text-fg">
          <div
            className="pointer-events-none absolute inset-x-0 top-0 h-[50%]"
            style={{
              background: `radial-gradient(60% 55% at 50% 20%, color-mix(in oklab, ${ROBIN.color} 16%, transparent), transparent)`,
            }}
          />
          <div className="relative flex w-full items-center justify-between pt-1 text-[15px]">
            <span className="flex items-center gap-1 text-muted-fg">
              <ChevronDown className="size-5" /> Chat
            </span>
            <span className="text-muted-fg tabular-nums">{CALL.elapsed}</span>
          </div>
          <div className="relative mt-9 flex flex-col items-center">
            <RingAvatar agent={ROBIN} size={112} presence={waiting ? "waiting" : "in_call"} />
            <span className="mt-6 font-semibold text-[28px] tracking-tight">{ROBIN.name}</span>
            <span
              className={cx(
                "mt-2.5 inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 font-medium text-[14px]",
                waiting ? "border-warn/30 bg-warn/10 text-warn" : "border-call/30 bg-call/10 text-call",
              )}
            >
              {waiting ? <ShieldAlert className="size-4" /> : <Wave color="currentColor" height={14} />}
              {CALL_STATE_LABEL[CALL.state]}
            </span>
          </div>
          <div className="relative mt-7 w-full space-y-2 text-[15.5px] leading-[1.4]">
            {CALL.transcript.map((t) => (
              <p key={t.text} className={cx(t.who === "you" ? "text-right text-muted-fg" : "text-fg")}>
                {t.text}
              </p>
            ))}
          </div>
          {waiting && (
            <div className="relative mt-5 w-full">
              <Approval command={'git commit -am "web: keep the DM header sticky on mobile"'} mobile />
            </div>
          )}
          <span className="flex-1" />
          <div className="relative mb-9 flex w-full items-center justify-around">
            {[
              [Mic, "mute", "bg-muted text-fg"],
              [Volume2, "speaker", "bg-muted text-fg"],
              [MessageSquare, "chat", "bg-muted text-fg"],
              [PhoneOff, "end", "bg-danger text-white"],
            ].map(([Icon, label, bg]) => {
              const I = Icon as typeof Mic;
              return (
                <span
                  key={label as string}
                  className="flex flex-col items-center gap-2 text-[12px] text-muted-fg"
                >
                  <span className={cx("flex size-16 items-center justify-center rounded-full", bg as string)}>
                    <I className="size-7" />
                  </span>
                  {label as string}
                </span>
              );
            })}
          </div>
        </div>
      </PhoneChrome>
    </div>
  );
}

// ---- ⌘K palette ------------------------------------------------------------------------------

function Palette() {
  return (
    <div className="absolute inset-0 z-30 bg-black/50 backdrop-blur-[2px]">
      <div className="elev mx-auto mt-[120px] w-[620px] overflow-hidden rounded-[16px] border border-line-strong bg-card text-[13.5px]">
        <div className="flex h-12 items-center gap-3 border-line border-b px-4">
          <Search className="size-4 text-muted-fg" />
          <span className="flex-1 text-muted-fg">Jump to an agent, run an action, search messages…</span>
          <Kbd>esc</Kbd>
        </div>
        <div className="px-2 py-2">
          <p className="px-3 pt-1 pb-1.5 font-medium text-[11px] text-muted-fg uppercase tracking-[0.08em]">
            Agents
          </p>
          {AGENTS.slice(0, 3).map((a, i) => {
            const s = statusLine(a);
            return (
              <div
                key={a.id}
                className={cx("flex h-10 items-center gap-3 rounded-[10px] px-3", i === 0 && "bg-muted")}
              >
                <RingAvatar agent={a} size={24} surface={i === 0 ? "var(--muted)" : "var(--card)"} />
                <span className="font-medium">{a.name}</span>
                <span className="truncate text-muted-fg" style={{ color: s.color }}>
                  {s.text}
                </span>
                <span className="flex-1" />
                {i === 0 && <Kbd>⏎</Kbd>}
              </div>
            );
          })}
          <p className="px-3 pt-3 pb-1.5 font-medium text-[11px] text-muted-fg uppercase tracking-[0.08em]">
            Actions
          </p>
          {[
            [Phone, "Call Robin"],
            [Plus, "New agent"],
            [Brain, "Open memories"],
          ].map(([Icon, label]) => {
            const I = Icon as typeof Phone;
            return (
              <div key={label as string} className="flex h-10 items-center gap-3 rounded-[10px] px-3">
                <span className="flex size-6 items-center justify-center text-muted-fg">
                  <I className="size-4" />
                </span>
                {label as string}
              </div>
            );
          })}
          <p className="px-3 pt-3 pb-1.5 font-medium text-[11px] text-muted-fg uppercase tracking-[0.08em]">
            Messages
          </p>
          {PALETTE_HITS.map((h) => (
            <div key={h.snippet} className="flex h-10 items-center gap-3 rounded-[10px] px-3">
              <span className="flex size-6 items-center justify-center text-muted-fg">
                <MessageSquare className="size-4" />
              </span>
              <span className="font-medium">{h.agent}</span>
              <span className="truncate text-muted-fg">{h.snippet}</span>
              <span className="ml-auto shrink-0 text-[11.5px] text-muted-fg tabular-nums">{h.time}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---- screens ---------------------------------------------------------------------------------

function Desktop({
  call = false,
  expanded = false,
  palette = false,
  light = false,
}: {
  call?: boolean;
  expanded?: boolean;
  palette?: boolean;
  light?: boolean;
}) {
  const robin = call ? IN_CALL : ROBIN;
  return (
    <div className={cx("relative flex h-full bg-bg font-sans text-fg", light && "light")}>
      <Sidebar
        active={robin}
        expanded={expanded}
        tooltipFor={expanded || call || palette ? undefined : "dana"}
      />
      <main className="relative flex min-w-0 flex-1 flex-col">
        <Header agent={robin} call={call} />
        <Thread />
        <Composer />
        {call && <CallCard />}
      </main>
      {palette && <Palette />}
    </div>
  );
}

function MobileAgents() {
  const attention = AGENTS.filter((a) => a.presence === "waiting" || a.presence === "error").length;
  return (
    <PhoneChrome dark>
      <div className="flex h-full flex-col bg-bg font-sans text-fg">
        <div className="flex items-end justify-between px-5 pt-2 pb-3">
          <span>
            <span className="block font-bold text-[28px] tracking-tight">Agents</span>
            <span className="block text-[13px] text-muted-fg">{attention} need your attention</span>
          </span>
          <span className="flex items-center gap-1">
            <span className="flex size-10 items-center justify-center rounded-full bg-card text-fg">
              <Search className="size-[18px]" />
            </span>
            <span className="flex size-10 items-center justify-center rounded-full bg-card text-fg">
              <SquarePen className="size-[18px]" />
            </span>
          </span>
        </div>
        <ul className="flex-1 px-3">
          {AGENTS.map((a) => {
            const s = statusLine(a);
            return (
              <li key={a.id} className="flex items-center gap-3.5 rounded-[14px] px-2.5 py-2.5">
                <RingAvatar agent={a} size={48} />
                <span className="min-w-0 flex-1 border-line border-b pb-3 leading-tight">
                  <span className="flex items-baseline justify-between">
                    <span className={cx("text-[16.5px]", a.unread ? "font-semibold" : "font-medium")}>
                      {a.name}
                    </span>
                    <span className="text-[12.5px] text-muted-fg tabular-nums">{a.last.time}</span>
                  </span>
                  <span className="mt-1 flex items-center gap-2">
                    <span
                      className="line-clamp-1 flex-1 text-[14px] text-muted-fg"
                      style={{ color: s.color }}
                    >
                      {s.text}
                    </span>
                    {a.unread > 0 && <Badge n={a.unread} />}
                  </span>
                </span>
              </li>
            );
          })}
          <li className="flex items-center gap-3.5 px-2.5 py-3 text-[15px] text-muted-fg">
            <span className="flex size-12 items-center justify-center rounded-full border border-line-strong border-dashed">
              <Plus className="size-5" />
            </span>
            New agent
          </li>
        </ul>
        <div className="flex items-start justify-around border-line border-t bg-panel px-2 pt-2 pb-7 text-[10.5px] text-muted-fg">
          {[
            [MessageSquare, "Agents", true],
            [Brain, "Memories", false],
            [Plug, "Tools", false],
            [Settings, "Settings", false],
          ].map(([Icon, label, on]) => {
            const I = Icon as typeof Brain;
            return (
              <span
                key={label as string}
                className={cx("flex w-16 flex-col items-center gap-1", on && "font-medium text-fg")}
              >
                <I className="size-[22px]" />
                {label as string}
              </span>
            );
          })}
        </div>
      </div>
    </PhoneChrome>
  );
}

function MobileDm() {
  return (
    <PhoneChrome dark>
      <div className="flex h-full flex-col bg-bg font-sans text-fg">
        <Header agent={IN_CALL} call mobile />
        <CallStrip />
        <Thread mobile />
        <Composer mobile />
      </div>
    </PhoneChrome>
  );
}

function make(variant: Variant, extraRoot?: string): DirectionImpl {
  const wrap = (node: ReactNode) => <VariantCtx.Provider value={variant}>{node}</VariantCtx.Provider>;
  return {
    rootClass: cx("dir-nocturne", extraRoot),
    screens: {
      "desktop-dm": () => wrap(<Desktop />),
      "desktop-dm-expanded": () => wrap(<Desktop expanded />),
      "desktop-call": () => wrap(<Desktop call expanded />),
      "mobile-agents": () => wrap(<MobileAgents />),
      "mobile-call": () => wrap(<MobileDm />),
      "mobile-call-sheet": () => wrap(<CallSheet />),
      "desktop-dm-light": () => wrap(<Desktop light expanded />),
      palette: () => wrap(<Desktop palette />),
      extra: () => wrap(<CallSheet />),
    },
  };
}

export const nocturne = make("bubbles");
export const nocturneB = make("rows", "variant-b");
export default nocturne;

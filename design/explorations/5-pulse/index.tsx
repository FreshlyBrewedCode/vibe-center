import {
  ArrowUp,
  Brain,
  Check,
  ChevronLeft,
  Mic,
  Phone,
  PhoneOff,
  Plus,
  Search,
  Settings,
  ShieldAlert,
  Terminal,
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
import { Avatar, Code, cx, PhoneChrome, PRESENCE_COLOR, ScrollBottom, Wave } from "../src/ui";
import "./theme.css";

function ring(a: Agent): string | undefined {
  if (a.presence === "idle") return undefined;
  return PRESENCE_COLOR[a.presence];
}

// ---- desktop ---------------------------------------------------------------------------------

function Desktop({ call = false }: { call?: boolean }) {
  const robin = call ? { ...ROBIN, presence: "in_call" as const, presenceDetail: "In a call" } : ROBIN;
  return (
    <div className="relative flex h-full bg-bg font-sans text-[14px] text-fg">
      <Backdrop />
      <Rail active={robin} />
      <main className="relative flex min-w-0 flex-1 flex-col">
        <Fade solid={call ? 150 : 66} height={call ? 200 : 110} />
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center pt-4">
          <Island agent={robin} call={call} />
        </div>
        <Stream call={call} />
        <Composer />
      </main>
    </div>
  );
}

function Backdrop() {
  return (
    <div
      className="pointer-events-none absolute inset-0"
      style={{
        background:
          "radial-gradient(50% 40% at 20% 0%, color-mix(in oklab, #7c5cff 22%, transparent), transparent), radial-gradient(40% 35% at 95% 100%, color-mix(in oklab, #ff5c8a 14%, transparent), transparent)",
      }}
    />
  );
}

/** Scrolled content fades out under the floating island instead of colliding with it. */
function Fade({ solid, height }: { solid: number; height: number }) {
  return (
    <div
      className="pointer-events-none absolute inset-x-0 top-0 z-[5]"
      style={{ height, background: `linear-gradient(to bottom, var(--bg) ${solid}px, transparent)` }}
    />
  );
}

function Rail({ active }: { active: Agent }) {
  return (
    <nav className="relative flex w-[84px] shrink-0 flex-col items-center gap-1 border-line/60 border-r bg-panel/60 pt-5 pb-4">
      <span className="grad mb-4 size-8 rounded-[10px]" />
      {AGENTS.map((a) => {
        const isActive = a.id === active.id;
        const shown = isActive ? active : a;
        const r = ring(shown);
        return (
          <div key={a.id} className="relative flex flex-col items-center py-2">
            <span
              className={cx(
                "absolute top-1/2 -left-[18px] h-7 w-1 -translate-y-1/2 rounded-r-full",
                isActive ? "grad" : "bg-transparent",
              )}
            />
            <span
              className={cx("relative rounded-full", r && "glow", isActive && !r && "ring-2 ring-white/20")}
              style={{ ["--ring" as string]: r }}
            >
              <Avatar agent={a} size={44} radius={22} />
              {a.unread > 0 && (
                <span className="-top-1 -right-1 absolute flex size-5 items-center justify-center rounded-full bg-danger font-semibold text-[10.5px] text-white">
                  {a.unread}
                </span>
              )}
            </span>
          </div>
        );
      })}
      <span className="mt-1 flex size-11 items-center justify-center rounded-full border border-line border-dashed text-muted-fg">
        <Plus className="size-5" />
      </span>
      <span className="flex-1" />
      <Search className="my-2 size-5 text-muted-fg" />
      <Brain className="my-2 size-5 text-muted-fg" />
      <Settings className="my-2 size-5 text-muted-fg" />
    </nav>
  );
}

/** The header is a capsule. In a call it expands into the call island. */
function Island({ agent, call, mobile = false }: { agent: Agent; call: boolean; mobile?: boolean }) {
  const waiting = CALL.state === "waiting";
  const r = ring(agent);
  if (!call) {
    return (
      <div
        className={cx(
          "glass pointer-events-auto flex items-center gap-3 rounded-full py-1.5 pr-2 pl-2",
          mobile && "w-full",
        )}
      >
        {mobile && <ChevronLeft className="ml-1 size-5 text-muted-fg" />}
        <span className={cx("rounded-full", r && "glow")} style={{ ["--ring" as string]: r }}>
          <Avatar agent={agent} size={32} radius={16} />
        </span>
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block font-semibold text-[14px]">{agent.name}</span>
          <span className="block truncate text-[11.5px]" style={{ color: PRESENCE_COLOR[agent.presence] }}>
            {agent.presenceDetail ?? PRESENCE_LABEL[agent.presence]}
          </span>
        </span>
        <button
          type="button"
          className="grad flex h-9 items-center gap-1.5 rounded-full px-3.5 font-semibold text-[13px] text-white shadow-lg shadow-accent/30"
        >
          <Phone className="size-4" /> Call
        </button>
      </div>
    );
  }
  return (
    <div className={cx("glass pointer-events-auto rounded-[28px] p-3", mobile ? "w-full" : "w-[560px]")}>
      <div className="flex items-center gap-3">
        {mobile && <ChevronLeft className="ml-1 size-5 text-muted-fg" />}
        <span className="rounded-full glow" style={{ ["--ring" as string]: "var(--call)" }}>
          <Avatar agent={agent} size={44} radius={22} />
        </span>
        <span className="min-w-0 flex-1 leading-tight">
          <span className="flex items-center gap-2 font-semibold text-[15px]">
            {agent.name}
            <span className="font-mono text-[12px] text-muted-fg tabular-nums">{CALL.elapsed}</span>
          </span>
          <span
            className={cx(
              "mt-0.5 flex items-center gap-1.5 text-[12.5px]",
              waiting ? "text-warn" : "text-call",
            )}
          >
            {waiting ? <ShieldAlert className="size-3.5" /> : <Wave color="currentColor" height={12} />}
            {CALL_STATE_LABEL[CALL.state]}
          </span>
        </span>
        <button
          type="button"
          className="flex size-10 items-center justify-center rounded-full bg-white/10"
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
      <div className="mt-2.5 border-white/10 border-t pt-2 text-[12.5px]">
        {CALL.transcript.slice(mobile ? -1 : -2).map((t) => (
          <p key={t.text} className={cx("truncate", t.who === "you" ? "text-muted-fg" : "text-fg/90")}>
            <span className="mr-1.5 text-muted-fg/70">{t.who === "you" ? "You" : agent.name}</span>
            {t.text}
          </p>
        ))}
      </div>
    </div>
  );
}

// ---- stream ----------------------------------------------------------------------------------

function Stream({ mobile = false, call = true }: { mobile?: boolean; call?: boolean }) {
  return (
    <ScrollBottom>
      <div
        className={cx(
          "mx-auto flex w-full flex-col gap-3 pb-4",
          mobile ? "px-4 pt-[215px]" : "max-w-[860px] px-10",
          !mobile && (call ? "pt-[200px]" : "pt-[110px]"),
        )}
      >
        {MESSAGES.map((m, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static mock
          <Item key={i} m={m} mobile={mobile} />
        ))}
      </div>
    </ScrollBottom>
  );
}

function Chip({ children, color }: { children: React.ReactNode; color?: string }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-line bg-muted/70 px-2.5 py-1 font-mono text-[11.5px]"
      style={color ? { color, borderColor: `color-mix(in oklab, ${color} 35%, transparent)` } : undefined}
    >
      {children}
    </span>
  );
}

function Item({ m, mobile }: { m: Msg; mobile: boolean }) {
  switch (m.kind) {
    case "session":
      return (
        <div className="py-2 text-center font-mono text-[11px] text-muted-fg uppercase tracking-widest">
          {m.label}
        </div>
      );
    case "user":
      return (
        <div className="flex flex-col items-end gap-1">
          {m.voice && (
            <span className="flex items-center gap-1 font-mono text-[10.5px] text-call uppercase tracking-wider">
              <Wave color="currentColor" height={10} bars={4} /> voice
            </span>
          )}
          <div
            className={cx(
              "glass rounded-[20px] rounded-tr-[6px] px-4 py-2.5 text-[15px] leading-[1.45]",
              mobile ? "max-w-[85%]" : "max-w-[70%]",
            )}
          >
            {m.text}
          </div>
        </div>
      );
    case "relay":
      return (
        <div className="flex gap-3">
          <Avatar agent={DANA} size={28} radius={14} className="mt-1" />
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex items-center gap-2 text-[12px]">
              <span className="font-semibold" style={{ color: DANA.color }}>
                {DANA.name}
              </span>
              <Chip color={DANA.color}>relay → {ROBIN.name}</Chip>
            </div>
            <p
              className="text-[15px] leading-[1.45]"
              style={{ borderLeft: `2px solid ${DANA.color}`, paddingLeft: 12 }}
            >
              {m.text}
            </p>
          </div>
        </div>
      );
    case "agent":
      return (
        <div className="flex gap-3">
          <Avatar agent={ROBIN} size={28} radius={14} className="mt-1" />
          <div className="min-w-0 flex-1 space-y-2.5">
            <div className="flex items-center gap-2 text-[12px]">
              <span className="font-semibold" style={{ color: ROBIN.color }}>
                {ROBIN.name}
              </span>
              <span className="text-muted-fg">{m.time}</span>
              {m.voice && (
                <span className="flex items-center gap-1 font-mono text-[10.5px] text-call uppercase tracking-wider">
                  <Wave color="currentColor" height={10} bars={4} /> voice
                </span>
              )}
            </div>
            {m.blocks.map((b, i) =>
              b.kind === "p" ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: static mock
                <p key={i} className="text-[15px] leading-[1.45]">
                  {b.text}
                  {m.streaming && i === m.blocks.length - 1 && (
                    <span className="grad ml-1 inline-block h-[14px] w-[8px] translate-y-[2px] rounded-sm vc-pulse" />
                  )}
                </p>
              ) : (
                // biome-ignore lint/suspicious/noArrayIndexKey: static mock
                <div key={i} className="overflow-hidden rounded-[14px] border border-line bg-panel">
                  <div className="flex items-center justify-between border-line border-b px-3.5 py-1.5 font-mono text-[10.5px] text-muted-fg uppercase tracking-wider">
                    <span>{b.lang}</span>
                    <span>copy</span>
                  </div>
                  <Code code={b.code} className={cx("px-3.5 py-2.5", mobile && "text-[11px]")} />
                </div>
              ),
            )}
          </div>
        </div>
      );
    case "tool":
      return (
        <div className="flex gap-3">
          <span className="w-7 shrink-0" />
          <Chip>
            <Terminal className="size-3.5 text-muted-fg" />
            <span className="text-fg">{m.title === "Edit" ? "edit" : "run"}</span>
            <span className="max-w-[320px] truncate text-muted-fg">
              {m.title === "Edit" ? "…/agents/$agentId/index.tsx" : m.detail}
            </span>
            <Check className="size-3.5 text-ok" />
            {m.output && <span className="text-muted-fg">48 pass</span>}
          </Chip>
        </div>
      );
    case "permission":
      return (
        <div className="flex gap-3">
          <span className="w-7 shrink-0" />
          <div className="grad min-w-0 flex-1 rounded-[18px] p-px shadow-lg shadow-accent/20">
            <div className="rounded-[17px] bg-card px-4 py-3.5">
              <div className="flex items-center gap-2 text-[13px]">
                <ShieldAlert className="size-4 text-warn" />
                <span className="font-semibold">Approve?</span>
                <span className="text-muted-fg">Robin wants to run</span>
              </div>
              <code className="mt-2 block rounded-[10px] bg-panel px-3 py-2 font-mono text-[12.5px] leading-snug">
                {m.command}
              </code>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  className="grad h-9 flex-1 rounded-full font-semibold text-[14px] text-white"
                >
                  Allow
                </button>
                <button
                  type="button"
                  className="h-9 flex-1 rounded-full border border-line font-semibold text-[14px]"
                >
                  Deny
                </button>
              </div>
            </div>
          </div>
        </div>
      );
    default:
      return null;
  }
}

function Composer({ mobile = false }: { mobile?: boolean }) {
  return (
    <div className={cx("shrink-0", mobile ? "px-4 pt-1 pb-8" : "px-10 pt-1 pb-5")}>
      <div className="glass mx-auto flex w-full max-w-[860px] items-center gap-2 rounded-full py-1.5 pr-1.5 pl-5">
        <span className="flex-1 text-[15px] text-muted-fg">Message Robin</span>
        <button
          type="button"
          className="flex size-10 items-center justify-center rounded-full bg-white/10"
          aria-label="Voice"
        >
          <Mic className="size-4" />
        </button>
        <button
          type="button"
          className="grad flex size-10 items-center justify-center rounded-full text-white"
          aria-label="Send"
        >
          <ArrowUp className="size-4" />
        </button>
      </div>
    </div>
  );
}

// ---- mobile ----------------------------------------------------------------------------------

function MobileCall() {
  const robin = { ...ROBIN, presence: "in_call" as const };
  return (
    <PhoneChrome dark>
      <div className="relative flex h-full flex-col bg-bg font-sans text-fg">
        <Backdrop />
        <Fade solid={165} height={215} />
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 px-3 pt-1">
          <Island agent={robin} call mobile />
        </div>
        <Stream mobile />
        <Composer mobile />
      </div>
    </PhoneChrome>
  );
}

function MobileHome() {
  return (
    <PhoneChrome dark>
      <div className="relative flex h-full flex-col bg-bg px-4 font-sans text-fg">
        <Backdrop />
        <div className="relative flex items-end justify-between pt-2">
          <span>
            <span className="block font-mono text-[11px] text-muted-fg uppercase tracking-widest">
              Vibe Center
            </span>
            <span className="block font-bold text-[30px] tracking-tight">Agents</span>
          </span>
          <span className="glass flex size-10 items-center justify-center rounded-full">
            <Search className="size-4" />
          </span>
        </div>
        <div className="relative mt-5 grid grid-cols-2 gap-3">
          {AGENTS.map((a) => {
            const r = ring(a);
            return (
              <div
                key={a.id}
                className="glass relative flex flex-col items-center rounded-[22px] px-3 pt-5 pb-4"
              >
                {a.unread > 0 && (
                  <span className="absolute top-3 right-3 flex size-6 items-center justify-center rounded-full bg-danger font-semibold text-[11px] text-white">
                    {a.unread}
                  </span>
                )}
                <span className={cx("rounded-full", r && "glow")} style={{ ["--ring" as string]: r }}>
                  <Avatar agent={a} size={56} radius={28} />
                </span>
                <span className="mt-3 font-semibold text-[16px]">{a.name}</span>
                <span
                  className="mt-0.5 line-clamp-1 text-center text-[12px]"
                  style={{ color: PRESENCE_COLOR[a.presence] }}
                >
                  {a.presenceDetail ?? PRESENCE_LABEL[a.presence]}
                </span>
                <div className="mt-3 flex gap-2">
                  <span className="flex size-9 items-center justify-center rounded-full bg-white/8">
                    <Phone className="size-4" />
                  </span>
                  <span className="grad flex size-9 items-center justify-center rounded-full text-white">
                    <ArrowUp className="size-4 rotate-45" />
                  </span>
                </div>
              </div>
            );
          })}
          <div className="flex flex-col items-center justify-center rounded-[22px] border border-line border-dashed py-6 text-muted-fg">
            <Plus className="size-6" />
            <span className="mt-1 text-[13px]">New agent</span>
          </div>
        </div>
        <span className="flex-1" />
        <div className="glass relative mb-8 flex items-center justify-around rounded-full py-3 text-muted-fg">
          <span className="grad-text font-semibold text-[12px]">Agents</span>
          <span className="text-[12px]">Calls</span>
          <span className="text-[12px]">Memories</span>
          <span className="text-[12px]">Settings</span>
        </div>
      </div>
    </PhoneChrome>
  );
}

const impl: DirectionImpl = {
  rootClass: "dir-pulse",
  screens: {
    "desktop-dm": () => <Desktop />,
    "desktop-call": () => <Desktop call />,
    "mobile-call": MobileCall,
    extra: MobileHome,
  },
};
export default impl;

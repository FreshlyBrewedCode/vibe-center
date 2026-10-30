import {
  ArrowUp,
  ChevronDown,
  ChevronLeft,
  Info,
  MessageSquare,
  Mic,
  MicOff,
  Phone,
  PhoneOff,
  Plus,
  Search,
  ShieldCheck,
  SquarePen,
  Volume2,
  Wrench,
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

const byRecency = [...AGENTS].sort(
  (a, b) => (a.last.time === "Yesterday" ? 1 : 0) - (b.last.time === "Yesterday" ? 1 : 0),
);

// ---- desktop ---------------------------------------------------------------------------------

function Desktop({ call = false }: { call?: boolean }) {
  const robin = call ? { ...ROBIN, presence: "in_call" as const, presenceDetail: "In a call" } : ROBIN;
  return (
    <div className="flex h-full bg-bg font-sans text-[15px] text-fg">
      <List active={robin} />
      <main className="relative flex min-w-0 flex-1 flex-col">
        <Header agent={robin} call={call} />
        <Thread />
        <Composer />
        {call && <CallCard />}
      </main>
    </div>
  );
}

function List({ active, mobile = false }: { active: Agent; mobile?: boolean }) {
  return (
    <nav
      className={cx(
        "flex shrink-0 flex-col border-line bg-panel",
        mobile ? "w-full bg-bg" : "w-[340px] border-r",
      )}
    >
      <div className={cx("flex items-center justify-between px-5 pt-4 pb-2", mobile && "pt-2")}>
        <span className={cx("font-bold tracking-tight", mobile ? "text-[32px]" : "text-[22px]")}>Agents</span>
        <span className="flex items-center gap-3 text-accent">
          <SquarePen className="size-5" />
        </span>
      </div>
      <div className="px-4 pb-2">
        <div className="flex h-9 items-center gap-2 rounded-[10px] bg-muted px-3 text-[15px] text-muted-fg">
          <Search className="size-4" /> Search
        </div>
      </div>
      <ul className="flex-1">
        {byRecency.map((a) => {
          const isActive = a.id === active.id && !mobile;
          const shown = isActive ? active : a;
          return (
            <li
              key={a.id}
              className={cx(
                "flex items-center gap-3 py-2 pr-4 pl-4",
                isActive && "bg-accent text-accent-fg",
                !isActive && "",
              )}
            >
              <span className="relative">
                <Avatar agent={a} size={50} radius={25} />
                <span
                  className={cx(
                    "absolute right-0 bottom-0 size-3.5 rounded-full",
                    (shown.presence === "working" || shown.presence === "thinking") && "vc-pulse",
                  )}
                  style={{
                    background: PRESENCE_COLOR[shown.presence],
                    boxShadow: `0 0 0 2px ${isActive ? "var(--accent)" : "var(--panel)"}`,
                  }}
                />
              </span>
              <span
                className="min-w-0 flex-1 border-line border-b py-1"
                style={{ borderColor: isActive ? "transparent" : undefined }}
              >
                <span className="flex items-baseline justify-between">
                  <span className={cx("text-[16px]", a.unread > 0 ? "font-semibold" : "font-medium")}>
                    {a.name}
                  </span>
                  <span className={cx("text-[13px]", isActive ? "text-accent-fg/70" : "text-muted-fg")}>
                    {a.last.time}
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  <span
                    className={cx(
                      "line-clamp-1 flex-1 text-[14px]",
                      isActive ? "text-accent-fg/80" : "text-muted-fg",
                    )}
                  >
                    {shown.presence === "idle" || shown.presence === "error" || isActive
                      ? a.last.text
                      : (shown.presenceDetail ?? PRESENCE_LABEL[shown.presence])}
                  </span>
                  {a.unread > 0 && <span className="size-2.5 shrink-0 rounded-full bg-info" />}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
      {!mobile && (
        <div className="flex items-center justify-around border-line border-t px-4 py-3 text-[11px] text-muted-fg">
          <span className="flex flex-col items-center gap-0.5 text-accent">
            <MessageSquare className="size-5" /> Agents
          </span>
          <span className="flex flex-col items-center gap-0.5">
            <Phone className="size-5" /> Calls
          </span>
          <span className="flex flex-col items-center gap-0.5">
            <ShieldCheck className="size-5" /> Memories
          </span>
        </div>
      )}
    </nav>
  );
}

function Header({ agent, call, mobile = false }: { agent: Agent; call: boolean; mobile?: boolean }) {
  return (
    <header
      className={cx(
        "flex shrink-0 items-center border-line border-b bg-bg/95 px-3 backdrop-blur",
        mobile ? "h-[58px]" : "h-[64px]",
      )}
    >
      <span className="flex w-16 items-center text-accent">
        {mobile && (
          <>
            <ChevronLeft className="size-6" />
            <span className="text-[16px]">Agents</span>
          </>
        )}
      </span>
      <span className="flex flex-1 flex-col items-center">
        <Avatar agent={agent} size={mobile ? 34 : 36} radius={18} />
        <span className="mt-0.5 flex items-center gap-1 text-[12px] leading-tight">
          <span className="font-semibold">{agent.name}</span>
          <ChevronDown className="size-3 text-muted-fg" />
        </span>
      </span>
      <span className="flex w-16 items-center justify-end gap-3 text-accent">
        {!call && <Phone className="size-5" />}
        <Info className="size-5" />
      </span>
    </header>
  );
}

function CallStrip({ mobile = false }: { mobile?: boolean }) {
  const waiting = CALL.state === "waiting";
  return (
    <div className="shrink-0 bg-call px-3 py-2 text-white">
      <div className="flex items-center gap-3">
        <span className="flex size-8 items-center justify-center rounded-full bg-white/20">
          {waiting ? <ShieldCheck className="size-4" /> : <Wave color="white" height={14} />}
        </span>
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block font-semibold text-[15px]">
            {waiting ? "Waiting for your approval" : CALL_STATE_LABEL[CALL.state]}
          </span>
          <span className="block text-[12px] text-white/80 tabular-nums">
            {CALL.elapsed} · {mobile ? "Tap to open the call" : `reply ${CALL.replyMs}s · GPU speech`}
          </span>
        </span>
        <button
          type="button"
          className="flex size-9 items-center justify-center rounded-full bg-white/20"
          aria-label="Mute"
        >
          <Mic className="size-4" />
        </button>
        <button
          type="button"
          className="flex size-9 items-center justify-center rounded-full bg-danger"
          aria-label="Hang up"
        >
          <PhoneOff className="size-4" />
        </button>
      </div>
    </div>
  );
}

/** Desktop: the call floats over the thread like a FaceTime picture-in-picture card. */
function CallCard() {
  const waiting = CALL.state === "waiting";
  return (
    <div className="absolute top-20 right-5 w-[300px] overflow-hidden rounded-[22px] bg-[#1c1c1e] text-white shadow-2xl ring-1 ring-black/20">
      <div className="flex flex-col items-center px-5 pt-6 pb-4">
        <span className="relative">
          <span className="absolute inset-0 -m-3 rounded-full bg-call/20" />
          <span className="absolute inset-0 -m-1.5 rounded-full bg-call/30" />
          <Avatar agent={ROBIN} size={72} radius={36} className="relative" />
        </span>
        <span className="mt-4 font-semibold text-[18px]">{ROBIN.name}</span>
        <span className="mt-0.5 text-[13px] text-white/60 tabular-nums">{CALL.elapsed}</span>
        <span
          className={cx(
            "mt-3 flex items-center gap-2 rounded-full px-3 py-1 font-medium text-[13px]",
            waiting ? "bg-warn/20 text-warn" : "bg-call/20 text-call",
          )}
        >
          {waiting ? <ShieldCheck className="size-3.5" /> : <Wave color="currentColor" height={12} />}
          {CALL_STATE_LABEL[CALL.state]}
        </span>
        <div className="mt-4 w-full space-y-1 text-[13px]">
          {CALL.transcript.slice(-2).map((t) => (
            <p
              key={t.text}
              className={cx("line-clamp-1", t.who === "you" ? "text-white/60" : "text-white/90")}
            >
              {t.who === "you" ? "You: " : ""}
              {t.text}
            </p>
          ))}
        </div>
      </div>
      <div className="flex items-center justify-center gap-4 bg-white/5 py-3">
        <button
          type="button"
          className="flex size-11 items-center justify-center rounded-full bg-white/15"
          aria-label="Mute"
        >
          <MicOff className="size-5" />
        </button>
        <button
          type="button"
          className="flex size-11 items-center justify-center rounded-full bg-white/15"
          aria-label="Speaker"
        >
          <Volume2 className="size-5" />
        </button>
        <button
          type="button"
          className="flex size-11 items-center justify-center rounded-full bg-danger"
          aria-label="Hang up"
        >
          <PhoneOff className="size-5" />
        </button>
      </div>
    </div>
  );
}

// ---- thread ----------------------------------------------------------------------------------

function Thread({ mobile = false }: { mobile?: boolean }) {
  return (
    <ScrollBottom className="bg-bg">
      <div className={cx("flex flex-col gap-1.5 pb-3", mobile ? "px-3" : "px-6")}>
        {MESSAGES.map((m, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static mock
          <Bubble key={i} m={m} mobile={mobile} />
        ))}
      </div>
    </ScrollBottom>
  );
}

function Bubble({ m, mobile }: { m: Msg; mobile: boolean }) {
  const max = mobile ? "max-w-[82%]" : "max-w-[62%]";
  switch (m.kind) {
    case "session":
      return <div className="py-3 text-center text-[12px] text-muted-fg">{m.label}</div>;
    case "user":
      return (
        <div className="flex flex-col items-end">
          {m.voice && <Caption who="you" voice />}
          <div
            className={cx(
              "rounded-[20px] rounded-br-[6px] bg-accent px-4 py-2 text-accent-fg leading-[1.35]",
              max,
            )}
          >
            {m.text}
          </div>
        </div>
      );
    case "relay":
      return (
        <div className="flex items-end gap-2">
          <Avatar agent={DANA} size={28} radius={14} />
          <div className={cx("flex flex-col", max)}>
            <span className="mb-0.5 ml-1 text-[11.5px] text-muted-fg">
              <span className="font-semibold" style={{ color: DANA.color }}>
                {DANA.name}
              </span>{" "}
              · to {ROBIN.name}
            </span>
            <div
              className="rounded-[20px] rounded-bl-[6px] px-4 py-2 leading-[1.35]"
              style={{ background: `color-mix(in oklab, ${DANA.color} 14%, white)` }}
            >
              {m.text}
            </div>
          </div>
        </div>
      );
    case "agent":
      return (
        <div className="flex items-end gap-2">
          <Avatar agent={ROBIN} size={28} radius={14} />
          <div className={cx("flex flex-col gap-1", max)}>
            {m.voice && <Caption who="robin" voice />}
            {m.blocks.map((b, i) =>
              b.kind === "p" ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: static mock
                <div key={i} className="rounded-[20px] rounded-bl-[6px] bg-muted px-4 py-2 leading-[1.35]">
                  {b.text}
                  {m.streaming && i === m.blocks.length - 1 && (
                    <span className="ml-1 inline-flex translate-y-[1px] gap-0.5">
                      <span className="size-1.5 rounded-full bg-muted-fg vc-pulse" />
                      <span className="size-1.5 rounded-full bg-muted-fg vc-pulse [animation-delay:200ms]" />
                      <span className="size-1.5 rounded-full bg-muted-fg vc-pulse [animation-delay:400ms]" />
                    </span>
                  )}
                </div>
              ) : (
                // biome-ignore lint/suspicious/noArrayIndexKey: static mock
                <div key={i} className="overflow-hidden rounded-[16px] bg-[#1c1c1e] text-white">
                  <div className="flex items-center justify-between px-3.5 pt-2 text-[11px] text-white/50">
                    <span>{b.lang}</span>
                    <span>Copy</span>
                  </div>
                  <Code
                    code={b.code}
                    className="px-3.5 py-2 text-[12px] [--code-kw:#ff9ff3] [--code-string:#9ce29c] [--code-tag:#8ac6ff]"
                  />
                </div>
              ),
            )}
          </div>
        </div>
      );
    case "tool":
      return (
        <div className="flex justify-center py-0.5">
          <span className="flex max-w-full items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-[12.5px] text-muted-fg">
            <Wrench className="size-3.5" />
            <span className="font-medium text-fg">{m.title === "Edit" ? "Edited" : "Ran"}</span>
            <span className="truncate font-mono text-[11.5px]">
              {m.title === "Edit" ? "index.tsx" : m.detail}
            </span>
            <span className="text-ok">✓</span>
            {m.output && <span className="text-muted-fg">· 48 tests pass</span>}
          </span>
        </div>
      );
    case "permission":
      return (
        <div className="flex items-end gap-2">
          <Avatar agent={ROBIN} size={28} radius={14} />
          <div
            className={cx(
              "overflow-hidden rounded-[20px] rounded-bl-[6px] border border-line bg-card shadow-sm",
              mobile ? "w-[88%]" : "w-[420px]",
            )}
          >
            <div className="flex items-center gap-2 border-line border-b bg-warn/10 px-4 py-2.5 text-[13px]">
              <ShieldCheck className="size-4 text-warn" />
              <span className="font-semibold">Robin wants to run</span>
            </div>
            <code className="block px-4 py-3 font-mono text-[12.5px] leading-snug">{m.command}</code>
            <div className="grid grid-cols-2 divide-x divide-line border-line border-t text-[16px]">
              <button type="button" className="py-2.5 font-semibold text-accent">
                Allow
              </button>
              <button type="button" className="py-2.5 text-danger">
                Deny
              </button>
            </div>
          </div>
        </div>
      );
    default:
      return null;
  }
}

function Caption({ who, voice }: { who: "you" | "robin"; voice?: boolean }) {
  return (
    <span
      className={cx(
        "mb-0.5 flex items-center gap-1 text-[11px] text-muted-fg",
        who === "you" ? "mr-1" : "ml-1",
      )}
    >
      {voice && <Volume2 className="size-3" />} {voice ? "Spoken" : ""}
    </span>
  );
}

function Composer({ mobile = false }: { mobile?: boolean }) {
  return (
    <div className={cx("flex shrink-0 items-end gap-2 bg-bg", mobile ? "px-3 pt-1 pb-8" : "px-6 pt-1 pb-4")}>
      <button
        type="button"
        className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-fg"
        aria-label="Add"
      >
        <Plus className="size-5" />
      </button>
      <div className="flex min-h-9 flex-1 items-center rounded-full border border-line px-4 text-[15px] text-muted-fg">
        Message
        <span className="flex-1" />
        <Mic className="size-4" />
      </div>
      <button
        type="button"
        className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent text-accent-fg"
        aria-label="Send"
      >
        <ArrowUp className="size-5" />
      </button>
    </div>
  );
}

// ---- mobile ----------------------------------------------------------------------------------

function MobileCall() {
  const robin = { ...ROBIN, presence: "in_call" as const };
  return (
    <PhoneChrome>
      <div className="flex h-full flex-col bg-bg font-sans text-[16px] text-fg">
        <Header agent={robin} call mobile />
        <CallStrip mobile />
        <Thread mobile />
        <Composer mobile />
      </div>
    </PhoneChrome>
  );
}

/** The bold part: the call as a full screen with captions and the approval right in it. */
function MobileCallSheet() {
  const waiting = CALL.state === "waiting";
  return (
    <div className="h-full bg-[#111114]">
      <PhoneChrome dark>
        <div className="relative flex h-full flex-col items-center bg-[#111114] px-5 font-sans text-white">
          <div
            className="pointer-events-none absolute inset-x-0 top-0 h-[55%]"
            style={{
              background: `radial-gradient(60% 50% at 50% 25%, color-mix(in oklab, ${ROBIN.color} 45%, transparent), transparent)`,
            }}
          />
          <div className="relative flex w-full items-center justify-between pt-1 text-[15px]">
            <span className="flex items-center gap-1 text-white/70">
              <ChevronDown className="size-5" /> Chat
            </span>
            <span className="text-white/60 tabular-nums">{CALL.elapsed}</span>
          </div>
          <div className="relative mt-10 flex flex-col items-center">
            <span className="relative">
              <span className="absolute inset-0 -m-6 rounded-full bg-white/5" />
              <span className="absolute inset-0 -m-3 rounded-full bg-white/8" />
              <Avatar agent={ROBIN} size={120} radius={60} className="relative" />
            </span>
            <span className="mt-6 font-semibold text-[30px] tracking-tight">{ROBIN.name}</span>
            <span
              className={cx(
                "mt-2 flex items-center gap-2 rounded-full px-3.5 py-1.5 font-medium text-[14px]",
                waiting ? "bg-warn/20 text-warn" : "bg-white/10",
              )}
            >
              {waiting ? <ShieldCheck className="size-4" /> : <Wave color="currentColor" height={14} />}
              {CALL_STATE_LABEL[CALL.state]}
            </span>
          </div>
          <div className="relative mt-8 w-full space-y-2 text-[15px]">
            {CALL.transcript.map((t) => (
              <p key={t.text} className={cx(t.who === "you" ? "text-right text-white/55" : "text-white/90")}>
                {t.text}
              </p>
            ))}
          </div>
          {waiting && (
            <div className="relative mt-5 w-full overflow-hidden rounded-[20px] bg-white/10 backdrop-blur">
              <div className="px-4 pt-3 text-[12px] text-white/60">Robin wants to run</div>
              <code className="block px-4 pt-1 pb-3 font-mono text-[12.5px] leading-snug">
                git commit -am "web: keep the DM header sticky on mobile"
              </code>
              <div className="grid grid-cols-2 divide-x divide-white/10 border-white/10 border-t text-[16px]">
                <button type="button" className="py-3 font-semibold text-[#8ef0b0]">
                  Allow
                </button>
                <button type="button" className="py-3 text-[#ff7a70]">
                  Deny
                </button>
              </div>
            </div>
          )}
          <span className="flex-1" />
          <div className="relative mb-10 flex w-full items-center justify-around">
            {[
              [Mic, "mute", "bg-white/15"],
              [Volume2, "speaker", "bg-white/15"],
              [MessageSquare, "chat", "bg-white/15"],
              [PhoneOff, "end", "bg-danger"],
            ].map(([Icon, label, bg]) => {
              const I = Icon as typeof Mic;
              return (
                <span
                  key={label as string}
                  className="flex flex-col items-center gap-2 text-[12px] text-white/70"
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

const impl: DirectionImpl = {
  rootClass: "dir-messenger",
  screens: {
    "desktop-dm": () => <Desktop />,
    "desktop-call": () => <Desktop call />,
    "mobile-call": MobileCall,
    extra: MobileCallSheet,
  },
};
export default impl;

import { ArrowLeft, Check, Mic, PhoneOff } from "lucide-react";
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
  TEMPLATES,
} from "../src/data";
import type { DirectionImpl } from "../src/directions";
import { Avatar, Code, cx, PhoneChrome, PRESENCE_COLOR, ScrollBottom } from "../src/ui";
import "./theme.css";

// ---- desktop ---------------------------------------------------------------------------------

function Desktop({ call = false }: { call?: boolean }) {
  const robin = call ? { ...ROBIN, presence: "in_call" as const, presenceDetail: "In a call" } : ROBIN;
  return (
    <div className="flex h-full bg-bg font-sans text-fg">
      <Index active={robin} />
      <main className="flex min-w-0 flex-1 flex-col">
        <Masthead agent={robin} call={call} />
        {call && <Ticker />}
        <Article />
        <Composer />
      </main>
    </div>
  );
}

function Index({ active }: { active: Agent }) {
  return (
    <nav className="flex w-[240px] shrink-0 flex-col border-line border-r bg-panel px-6 pt-7">
      <span className="display font-semibold text-[22px] leading-none tracking-tight">Vibe Center</span>
      <span className="label mt-6 text-muted-fg">Correspondents</span>
      <ul className="mt-2">
        {AGENTS.map((a) => {
          const isActive = a.id === active.id;
          const shown = isActive ? active : a;
          return (
            <li key={a.id} className="border-line border-b py-2.5">
              <div className="flex items-baseline gap-2">
                <span
                  className={cx(
                    "serif text-[17px]",
                    isActive ? "text-accent" : a.unread > 0 ? "font-semibold" : "",
                  )}
                >
                  {a.name}
                </span>
                {a.unread > 0 && <span className="serif text-[13px] text-accent italic">{a.unread} new</span>}
              </div>
              <div className="flex items-center gap-1.5 text-[12px] text-muted-fg">
                <span
                  className={cx(
                    "size-1.5 rounded-full",
                    (shown.presence === "working" || shown.presence === "thinking") && "vc-pulse",
                  )}
                  style={{ background: PRESENCE_COLOR[shown.presence] }}
                />
                <span className="serif truncate italic">
                  {(shown.presenceDetail ?? PRESENCE_LABEL[shown.presence]).toLowerCase()}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
      <span className="flex-1" />
      <div className="label space-y-2.5 pb-6 text-muted-fg">
        <div>Search ⌘K</div>
        <div>New correspondent</div>
        <div>Memories</div>
        <div>Settings</div>
      </div>
    </nav>
  );
}

function Masthead({ agent, call, mobile = false }: { agent: Agent; call: boolean; mobile?: boolean }) {
  return (
    <header
      className={cx(
        "flex shrink-0 items-end gap-4 border-line border-b bg-bg",
        mobile ? "h-[64px] px-5 pb-2.5" : "h-[88px] px-12 pb-4",
      )}
    >
      {mobile && <ArrowLeft className="mb-1.5 size-5 text-muted-fg" />}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-3">
          <span
            className={cx(
              "display font-semibold tracking-tight",
              mobile ? "text-[26px] leading-none" : "text-[34px] leading-none",
            )}
          >
            {agent.name}
          </span>
          {!mobile && <span className="serif text-[15px] text-muted-fg italic">{agent.description}</span>}
        </div>
        <div className={cx("label mt-1.5 flex items-center gap-2", call ? "text-call" : "text-muted-fg")}>
          <span className="size-1.5 rounded-full" style={{ background: PRESENCE_COLOR[agent.presence] }} />
          {call ? "In a call" : (agent.presenceDetail ?? PRESENCE_LABEL[agent.presence])}
          {!mobile && (
            <span className="text-muted-fg/60">
              · {agent.harness} · {agent.model}
            </span>
          )}
        </div>
      </div>
      {!mobile && (
        <div className="label flex items-center gap-5 pb-1 text-fg">
          {!call && <span className="border-accent border-b pb-px text-accent">Call</span>}
          <span className="text-muted-fg">New session</span>
          <span className="text-muted-fg">Details</span>
        </div>
      )}
      {mobile && !call && <span className="label mb-1.5 border-accent border-b text-accent">Call</span>}
    </header>
  );
}

function Ticker({ mobile = false }: { mobile?: boolean }) {
  const waiting = CALL.state === "waiting";
  return (
    <div
      className={cx(
        "label flex shrink-0 items-center gap-3 border-line border-b bg-panel text-fg",
        mobile ? "h-10 px-5" : "h-10 px-12",
      )}
    >
      <span className="flex items-center gap-1.5 text-accent">
        <span className={cx("size-2 rounded-full bg-accent", !waiting && "vc-pulse")} /> Live
      </span>
      <span className="text-muted-fg">{CALL.elapsed}</span>
      <span className={waiting ? "text-warn" : ""}>{CALL_STATE_LABEL[CALL.state]}</span>
      {!mobile && (
        <span className="serif min-w-0 flex-1 truncate font-normal text-[14px] text-muted-fg normal-case italic tracking-normal">
          “{CALL.transcript.at(-1)?.text}” — you
        </span>
      )}
      {mobile && <span className="flex-1" />}
      <Mic className="size-3.5" />
      <span className="flex items-center gap-1 text-accent">
        <PhoneOff className="size-3.5" /> {!mobile && "Hang up"}
      </span>
    </div>
  );
}

// ---- article ---------------------------------------------------------------------------------

type ToolMsg = Extract<Msg, { kind: "tool" }>;
type Grouped = { m: Exclude<Msg, ToolMsg>; notes: ToolMsg[] };

/** Tool calls attach to the turn before them, so they can sit in that turn's margin. */
function group(messages: Msg[]): Grouped[] {
  const out: Grouped[] = [];
  for (const m of messages) {
    if (m.kind === "tool" && out.length) out[out.length - 1]!.notes.push(m);
    else if (m.kind !== "tool") out.push({ m, notes: [] });
  }
  return out;
}

function Article({ mobile = false }: { mobile?: boolean }) {
  return (
    <ScrollBottom className="bg-bg">
      <div className={cx("mx-auto w-full pb-6", mobile ? "px-5" : "max-w-[920px] px-12")}>
        {group(MESSAGES).map((g, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static mock
          <Turn key={i} m={g.m} notes={g.notes} mobile={mobile} />
        ))}
      </div>
    </ScrollBottom>
  );
}

function Note({ m, mobile }: { m: ToolMsg; mobile: boolean }) {
  const short = m.title === "Edit" ? "…/agents/$agentId/index.tsx" : m.detail;
  return (
    <div
      className={cx(
        "font-mono text-[11.5px] text-muted-fg leading-snug",
        mobile ? "flex items-center gap-2" : "",
      )}
    >
      <span className="flex items-center gap-1.5">
        <Check className="size-3 text-ok" />
        <span className="text-fg">{m.title === "Edit" ? "Edited" : "Ran"}</span>
        {mobile && <span className="truncate">{short}</span>}
      </span>
      {!mobile && <div className="mt-0.5">{short}</div>}
      {!mobile && m.output && <div className="mt-0.5">48 tests pass · 41 s</div>}
    </div>
  );
}

/** On desktop each turn has a 600px measure plus a right margin where tool calls sit as notes. */
function Turn({ m, notes, mobile }: { m: Exclude<Msg, ToolMsg>; notes: ToolMsg[]; mobile: boolean }) {
  if (m.kind === "session") {
    return <div className="label py-6 text-center text-muted-fg">— {m.label} —</div>;
  }
  const who = m.kind === "user" ? "You" : m.kind === "relay" ? DANA.name : ROBIN.name;
  const voice = (m.kind === "user" || m.kind === "agent") && m.voice;
  const color = m.kind === "relay" ? DANA.color : m.kind === "user" ? "var(--fg)" : ROBIN.color;
  return (
    <div className={cx("flex gap-10", mobile ? "mt-6" : "mt-7")}>
      <div className={cx("min-w-0", mobile ? "flex-1" : "w-[600px] shrink-0")}>
        <div className="label mb-1.5 flex items-center gap-2 text-muted-fg">
          {m.kind !== "user" && <Avatar agent={m.kind === "relay" ? DANA : ROBIN} size={16} radius={8} />}
          <span style={{ color }}>{who}</span>
          {m.kind === "relay" && <span className="normal-case tracking-normal">to {ROBIN.name}</span>}
          <span>{m.time}</span>
          {voice && <span className="text-call">◆ spoken</span>}
          {m.kind === "permission" && <span className="text-warn">needs your answer</span>}
        </div>
        <Body m={m} mobile={mobile} />
        {mobile && notes.length > 0 && (
          <div className="mt-3 space-y-1.5 border-line border-l pl-3">
            {notes.map((n) => (
              <Note key={n.detail} m={n} mobile />
            ))}
          </div>
        )}
      </div>
      {!mobile && (
        <div
          className={cx("w-[200px] self-end", notes.length > 0 && "space-y-2 border-line border-l pl-4 pb-1")}
        >
          {notes.map((n) => (
            <Note key={n.detail} m={n} mobile={false} />
          ))}
        </div>
      )}
    </div>
  );
}

function Body({ m, mobile }: { m: Msg; mobile: boolean }) {
  const p = cx("serif leading-[1.5]", mobile ? "text-[17px]" : "text-[18px]");
  switch (m.kind) {
    case "user":
      return <p className={cx(p, "font-medium")}>{m.text}</p>;
    case "relay":
      return <p className={cx(p, "italic")}>{m.text}</p>;
    case "agent":
      return (
        <div className="space-y-3">
          {m.blocks.map((b, i) =>
            b.kind === "p" ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: static mock
              <p key={i} className={p}>
                {b.text}
                {m.streaming && i === m.blocks.length - 1 && (
                  <span className="ml-1 inline-block h-[16px] w-[2px] translate-y-[2px] bg-accent vc-pulse" />
                )}
              </p>
            ) : (
              <Code
                // biome-ignore lint/suspicious/noArrayIndexKey: static mock
                key={i}
                code={b.code}
                className={cx(
                  "border-line border-y bg-muted/60 py-3 text-[12px]",
                  mobile ? "-mx-5 px-5 text-[11px]" : "px-4",
                )}
              />
            ),
          )}
        </div>
      );
    case "permission":
      return (
        <div className="mt-1 border-accent border-l-2 pl-4">
          <p className={cx(p)}>
            Robin asks to run <code className="font-mono text-[14px]">{m.command}</code>
          </p>
          <div className="mt-3 flex items-center gap-3">
            <button type="button" className="label h-8 bg-accent px-4 text-accent-fg">
              Allow
            </button>
            <button type="button" className="label h-8 border border-line px-4 text-fg">
              Deny
            </button>
            {!mobile && (
              <span className="serif text-[14px] text-muted-fg italic">or say “allow” in the call</span>
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
    <div className={cx("shrink-0 bg-bg", mobile ? "px-5 pt-2 pb-8" : "px-12 pt-2 pb-6")}>
      <div
        className={cx(
          "mx-auto flex w-full items-end gap-4 border-fg/60 border-b pb-2",
          !mobile && "max-w-[920px]",
        )}
      >
        <span className="serif flex-1 text-[18px] text-muted-fg italic">Write to Robin…</span>
        <Mic className="mb-1 size-4 text-muted-fg" />
        <span className="label text-accent">Send ↵</span>
      </div>
    </div>
  );
}

// ---- mobile ----------------------------------------------------------------------------------

function MobileCall() {
  const robin = { ...ROBIN, presence: "in_call" as const };
  return (
    <PhoneChrome>
      <div className="flex h-full flex-col bg-bg font-sans text-fg">
        <Masthead agent={robin} call mobile />
        <Ticker mobile />
        <Article mobile />
        <Composer mobile />
      </div>
    </PhoneChrome>
  );
}

function NewAgent() {
  return (
    <div className="flex h-full bg-bg font-sans text-fg">
      <Index active={ROBIN} />
      <main className="flex min-w-0 flex-1 flex-col px-12 pt-10">
        <span className="label text-muted-fg">New correspondent</span>
        <h1 className="display mt-2 font-semibold text-[44px] leading-none tracking-tight">
          Who are we hiring?
        </h1>
        <p className="serif mt-3 max-w-[560px] text-[18px] text-muted-fg italic leading-[1.45]">
          Start from a template. The prompt, tools and harness it fills in stay editable afterwards.
        </p>
        <div className="mt-10 grid max-w-[920px] grid-cols-3 gap-6">
          {TEMPLATES.map((t, i) => (
            <div
              key={t.name}
              className={cx("flex h-[260px] flex-col border-line border-t pt-4", i === 0 && "border-accent")}
            >
              <span className="text-[32px]">{t.emoji}</span>
              <span className="display mt-4 font-semibold text-[26px] leading-tight">{t.name}</span>
              <p className="serif mt-2 text-[16px] text-muted-fg leading-[1.45]">{t.blurb}</p>
              <span className="flex-1" />
              <span className={cx("label", i === 0 ? "text-accent" : "text-muted-fg")}>
                {i === 0 ? "Selected →" : "Choose"}
              </span>
            </div>
          ))}
        </div>
        <div className="mt-12 max-w-[920px] border-line border-t pt-6">
          <div className="grid grid-cols-[160px_1fr] gap-y-5 text-[15px]">
            <span className="label pt-1 text-muted-fg">Name</span>
            <span className="serif border-fg/60 border-b pb-1 text-[20px]">Wren</span>
            <span className="label pt-1 text-muted-fg">Harness</span>
            <span className="serif text-[18px]">
              Claude Code <span className="text-muted-fg">· claude-sonnet-5</span>
            </span>
            <span className="label pt-1 text-muted-fg">Directory</span>
            <span className="font-mono text-[14px]">~/src/vibe-center</span>
            <span className="label pt-1 text-muted-fg">Voice</span>
            <span className="serif text-[18px] italic">Michael</span>
          </div>
          <div className="mt-8 flex items-center gap-4">
            <button type="button" className="label h-9 bg-accent px-5 text-accent-fg">
              Create agent
            </button>
            <span className="label text-muted-fg">Cancel</span>
          </div>
        </div>
      </main>
    </div>
  );
}

const impl: DirectionImpl = {
  rootClass: "dir-editorial",
  screens: {
    "desktop-dm": () => <Desktop />,
    "desktop-call": () => <Desktop call />,
    "mobile-call": MobileCall,
    extra: NewAgent,
  },
};
export default impl;

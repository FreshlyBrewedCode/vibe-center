import { type ReactNode, useEffect, useRef } from "react";
import type { Agent, Presence } from "./data";

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

export const PRESENCE_COLOR: Record<Presence, string> = {
  idle: "var(--muted-fg)",
  thinking: "var(--info)",
  working: "var(--ok)",
  waiting: "var(--warn)",
  in_call: "var(--call)",
  error: "var(--danger)",
};

/** Emoji avatar on a tinted square, as in the app. `mono` uses the initial instead of the emoji. */
export function Avatar({
  agent,
  size = 32,
  radius = 8,
  presence,
  mono = false,
  ringColor,
  className,
}: {
  agent: Agent;
  size?: number;
  radius?: number | string;
  presence?: Presence;
  mono?: boolean;
  /** Colour of the ring around the presence dot (the surface it sits on). */
  ringColor?: string;
  className?: string;
}) {
  const dot = Math.max(8, Math.round(size * 0.3));
  return (
    <span
      className={cx("relative inline-flex shrink-0 select-none items-center justify-center", className)}
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        background: mono ? agent.color : `color-mix(in oklab, ${agent.color} 22%, transparent)`,
        color: mono ? "white" : undefined,
        fontSize: mono ? size * 0.44 : size * 0.52,
        fontWeight: mono ? 600 : undefined,
        lineHeight: 1,
      }}
    >
      {mono ? agent.initial : agent.emoji}
      {presence && (
        <span
          className={cx(
            "absolute rounded-full",
            (presence === "thinking" || presence === "working") && "vc-pulse",
          )}
          style={{
            width: dot,
            height: dot,
            right: -dot * 0.2,
            bottom: -dot * 0.2,
            background: PRESENCE_COLOR[presence],
            boxShadow: `0 0 0 2px ${ringColor ?? "var(--bg)"}`,
          }}
        />
      )}
    </span>
  );
}

/** Tiny syntax colouring for the mock code block: keywords, strings, comments, JSX tags. */
export function Code({ code, className }: { code: string; className?: string }) {
  const lines = code.split("\n");
  return (
    <pre className={cx("overflow-x-auto font-mono text-[12.5px] leading-[1.55]", className)}>
      {lines.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static mock content
        <div key={i}>{tokenize(line)}</div>
      ))}
    </pre>
  );
}

const TOKEN =
  /(\/\/.*$|\{\/\*.*?\*\/\}|"[^"]*"|<\/?[A-Za-z][\w.]*|\b(?:const|let|return|import|from|export|function)\b|…)/g;

function tokenize(line: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of line.matchAll(TOKEN)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(line.slice(last, idx));
    const t = m[0];
    const cls = t.startsWith("//")
      ? "text-muted-fg italic"
      : t.startsWith("{/*")
        ? "text-muted-fg italic"
        : t.startsWith('"')
          ? "text-[var(--code-string,#2a9d8f)]"
          : t.startsWith("<")
            ? "text-[var(--code-tag,#c2410c)]"
            : t === "…"
              ? "text-muted-fg"
              : "text-[var(--code-kw,#7c3aed)]";
    out.push(
      <span key={i++} className={cls}>
        {t}
      </span>,
    );
    last = idx + t.length;
  }
  if (last < line.length) out.push(line.slice(last));
  if (out.length === 0) out.push(" ");
  return out;
}

/** Three-bar "speaking" waveform. Static heights; the real one animates. */
export function Wave({
  color = "currentColor",
  height = 16,
  bars = 5,
}: {
  color?: string;
  height?: number;
  bars?: number;
}) {
  const hs = [0.35, 0.8, 1, 0.6, 0.45, 0.9, 0.5];
  return (
    <span className="inline-flex items-center gap-[2px]" style={{ height }}>
      {Array.from({ length: bars }, (_, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: static bars
          key={i}
          className="inline-block w-[3px] rounded-full"
          style={{ height: Math.max(3, height * (hs[i % hs.length] ?? 0.5)), background: color }}
        />
      ))}
    </span>
  );
}

/** Narrow iPhone-shaped frame for mobile screens: the status bar and home indicator. */
export function PhoneChrome({ children, dark = false }: { children: ReactNode; dark?: boolean }) {
  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden">
      <div
        className={cx(
          "flex h-[47px] shrink-0 items-end justify-between px-7 pb-2 font-semibold text-[15px]",
          dark ? "text-white" : "text-black",
        )}
      >
        <span>9:41</span>
        <span className="flex items-center gap-1.5 text-[11px] tracking-tight">
          <span>●●●●</span>
          <span>WiFi</span>
          <span className="rounded-[3px] border border-current px-1">100</span>
        </span>
      </div>
      <div className="min-h-0 flex-1">{children}</div>
      <div className="pointer-events-none absolute right-0 bottom-2 left-0 flex justify-center">
        <span className={cx("h-[5px] w-[134px] rounded-full", dark ? "bg-white/90" : "bg-black/90")} />
      </div>
    </div>
  );
}

/** A scroll container that starts scrolled to the bottom, like a DM that opened on the latest message. */
export function ScrollBottom({ className, children }: { className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  });
  return (
    <div ref={ref} className={cx("vc-noscroll min-h-0 flex-1 overflow-y-auto", className)}>
      {children}
    </div>
  );
}

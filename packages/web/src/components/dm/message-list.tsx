import type { AgentView, Message } from "@vibe-center/shared";
import { Loader2 } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLoadOlderMessages } from "@/lib/queries";
import { AgentAvatar } from "../agent-avatar";
import { type Fold, MessageItem } from "./message-item";

/**
 * Groups runs by sender identity, not just role: a plain user message, a relayed agent-to-agent
 * message/reply (keyed by the other agent) and the DM's own agent are all distinct senders, and
 * a run never spans a session divider. Every kind participates (not just text), so a tool call or
 * permission request that opens a turn gets its own header instead of visually sitting under
 * whatever the previous header happened to be (e.g. the user's last message).
 */
function senderKey(m: Message): string {
  if (m.kind === "session") return `session:${m.id}`;
  if (m.role === "user" && (m.kind === "text" || m.kind === "voice_transcript")) {
    const data = m.data;
    if (data?.fromAgentId && (data.source === "agent" || data.source === "event")) {
      return `relay:${data.fromAgentId}:${data.source}`;
    }
    return "user";
  }
  return m.role; // "agent" | "system" (and the rare role="user" non-relay card, if any)
}

function sameDay(a: number, b: number): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

function dateLabel(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  if (sameDay(ts, now.getTime())) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(ts, yesterday.getTime())) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "long", year: "numeric", month: "long", day: "numeric" });
}

/**
 * The DM transcript. Sticks to the bottom while new content streams in (unless scrolled up),
 * loads older pages as you scroll to the top, and can jump to and briefly highlight one message
 * (⌘K search results land here via `jumpToSeq`). Consecutive tool calls fold into one activity
 * card (`Fold`), so a run of edits reads as one event; every call stays its own message.
 */
export function MessageList({
  conversationId,
  messages,
  hasMore,
  agent,
  jumpToSeq,
  onJumpHandled,
}: {
  conversationId: string;
  messages: Message[];
  hasMore: boolean;
  agent: AgentView;
  jumpToSeq?: number | null;
  onJumpHandled?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const topSentinel = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const last = messages.at(-1);
  const first = messages[0];
  const loadOlder = useLoadOlderMessages(conversationId);

  // The sentinel never moves, so the observer is set up once; a ref keeps its callback reading
  // the latest hasMore/first/mutate without having to tear it down and reconnect on every change.
  const stateRef = useRef({ hasMore, first, mutate: loadOlder.mutate, pending: loadOlder.isPending });
  stateRef.current = { hasMore, first, mutate: loadOlder.mutate, pending: loadOlder.isPending };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // Infinite scroll: fetch the previous page when the top sentinel comes into view, preserving
  // scroll position by measuring how much content height the prepend added.
  useEffect(() => {
    const root = ref.current;
    const sentinel = topSentinel.current;
    if (!root || !sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const { hasMore: more, first: oldest, mutate, pending } = stateRef.current;
        if (!entries[0]?.isIntersecting || !more || !oldest || pending) return;
        const before = root.scrollHeight;
        mutate(oldest.seq, {
          onSuccess: () => {
            requestAnimationFrame(() => {
              root.scrollTop += root.scrollHeight - before;
            });
          },
        });
      },
      { root, threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run whenever the content grows
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, last?.text.length, last?.status]);

  useJumpTo(ref, messages, jumpToSeq, onJumpHandled);

  const rows = layout(messages);

  return (
    <div
      ref={ref}
      data-testid="message-list"
      className="vc-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain pb-4 text-[16px] sm:text-base"
    >
      <div ref={topSentinel} />
      {hasMore && (
        <div className="flex justify-center py-3 text-muted-foreground text-xs">
          {loadOlder.isPending ? <Loader2 className="size-3.5 animate-spin" /> : "Scroll up for more"}
        </div>
      )}
      {messages.length === 0 && (
        <div className="mx-auto flex max-w-sm flex-col items-center gap-3 px-6 pt-16 text-center">
          <AgentAvatar avatar={agent.avatar} size={56} />
          <p className="font-semibold text-base">This is the start of your DM with {agent.name}.</p>
          {agent.description && <p className="text-muted-foreground text-sm">{agent.description}</p>}
        </div>
      )}
      {rows.map(({ message: m, showHeader, showDate, fold }) => (
        <div key={m.id} data-seq={m.seq}>
          {showDate && <Divider label={dateLabel(m.createdAt)} />}
          <MessageItem message={m} agent={agent} showHeader={showHeader} fold={fold} />
        </div>
      ))}
    </div>
  );
}

interface Row {
  message: Message;
  showHeader: boolean;
  showDate: boolean;
  fold: Fold;
}

/** Headers per sender run, date dividers, and the fold position of each tool call in its run. */
function layout(messages: Message[]): Row[] {
  const rows: Row[] = messages.map((m, i) => {
    const prev = messages[i - 1];
    const showDate = !prev || !sameDay(prev.createdAt, m.createdAt);
    // A sender header starts each run from the same sender (session dividers always start a
    // fresh run, and session itself never gets one).
    const showHeader =
      m.kind !== "session" &&
      (!prev ||
        prev.kind === "session" ||
        senderKey(prev) !== senderKey(m) ||
        m.createdAt - prev.createdAt >= 5 * 60_000 ||
        showDate);
    return { message: m, showHeader, showDate, fold: "single" };
  });
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.message.kind !== "tool_call") continue;
    const prevFolds = i > 0 && rows[i - 1]!.message.kind === "tool_call" && !row.showHeader;
    const next = rows[i + 1];
    const nextFolds = !!next && next.message.kind === "tool_call" && !next.showHeader && !next.showDate;
    row.fold = prevFolds ? (nextFolds ? "middle" : "last") : nextFolds ? "first" : "single";
  }
  return rows;
}

/** A hairline divider with a centred label (dates; sessions use the same shape). */
export function Divider({ label, title, testId }: { label: string; title?: string; testId?: string }) {
  return (
    <div data-testid={testId} className="flex items-center gap-3 px-4 py-3 text-muted-foreground text-xs sm:px-10">
      <div className="h-px flex-1 bg-line" />
      <span title={title} className="shrink-0">
        {label}
      </span>
      <div className="h-px flex-1 bg-line" />
    </div>
  );
}

function useJumpTo(
  containerRef: React.RefObject<HTMLDivElement | null>,
  messages: Message[],
  jumpToSeq: number | null | undefined,
  onJumpHandled?: () => void,
): void {
  const [flashSeq, setFlashSeq] = useState<number | null>(null);
  const onJumpHandledRef = useRef(onJumpHandled);
  onJumpHandledRef.current = onJumpHandled;

  useEffect(() => {
    if (jumpToSeq == null) return;
    const container = containerRef.current;
    if (!container || !messages.some((m) => m.seq === jumpToSeq)) return;
    const el = container.querySelector<HTMLElement>(`[data-seq="${jumpToSeq}"]`);
    if (el) {
      el.scrollIntoView({ block: "center" });
      setFlashSeq(jumpToSeq);
      setTimeout(() => setFlashSeq(null), 1600);
    }
    onJumpHandledRef.current?.();
  }, [jumpToSeq, messages, containerRef]);

  useEffect(() => {
    if (flashSeq == null) return;
    const el = containerRef.current?.querySelector<HTMLElement>(`[data-seq="${flashSeq}"]`);
    el?.classList.add("jump-highlight");
    return () => el?.classList.remove("jump-highlight");
  }, [flashSeq, containerRef]);
}

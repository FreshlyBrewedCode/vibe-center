import type { AgentView, Message } from "@vibe-center/shared";
import { Loader2 } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLoadOlderMessages } from "@/lib/queries";
import { MessageItem } from "./message-item";

const HEADER_KINDS = new Set<Message["kind"]>(["text", "voice_transcript"]);

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
 * (⌘K search results land here via `jumpToSeq`).
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

  return (
    <div ref={ref} className="flex-1 overflow-y-auto pb-4">
      <div ref={topSentinel} />
      {hasMore && (
        <div className="flex justify-center py-3 text-muted-foreground text-xs">
          {loadOlder.isPending ? <Loader2 className="size-3.5 animate-spin" /> : "Scroll up for more"}
        </div>
      )}
      {messages.length === 0 && (
        <p className="p-6 text-center text-muted-foreground text-sm">
          This is the start of your DM with {agent.name}.
        </p>
      )}
      {messages.map((m, i) => {
        const prev = messages[i - 1];
        const showDate = !prev || !sameDay(prev.createdAt, m.createdAt);
        // A sender header starts each run of text from the same side.
        const showHeader =
          HEADER_KINDS.has(m.kind) &&
          !(
            prev &&
            prev.role === m.role &&
            HEADER_KINDS.has(prev.kind) &&
            m.createdAt - prev.createdAt < 5 * 60_000 &&
            !showDate
          );
        return (
          <div key={m.id} data-seq={m.seq}>
            {showDate && (
              <div className="flex items-center gap-3 px-4 py-3 text-muted-foreground text-xs">
                <div className="h-px flex-1 bg-border" />
                <span>{dateLabel(m.createdAt)}</span>
                <div className="h-px flex-1 bg-border" />
              </div>
            )}
            <MessageItem message={m} agent={agent} showHeader={showHeader} />
          </div>
        );
      })}
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

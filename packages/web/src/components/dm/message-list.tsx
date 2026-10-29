import type { AgentView, Message } from "@vibe-center/shared";
import { useEffect, useLayoutEffect, useRef } from "react";
import { MessageItem } from "./message-item";

const HEADER_KINDS = new Set<Message["kind"]>(["text", "voice_transcript"]);

/** The DM transcript. Sticks to the bottom while new content streams in, unless scrolled up. */
export function MessageList({ messages, agent }: { messages: Message[]; agent: AgentView }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const last = messages.at(-1);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run whenever the content grows
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, last?.text.length, last?.status]);

  return (
    <div ref={ref} className="flex-1 overflow-y-auto pb-4">
      {messages.length === 0 && (
        <p className="p-6 text-center text-muted-foreground text-sm">
          This is the start of your DM with {agent.name}.
        </p>
      )}
      {messages.map((m, i) => {
        const prev = messages[i - 1];
        // A sender header starts each run of text from the same side.
        const showHeader =
          HEADER_KINDS.has(m.kind) &&
          !(
            prev &&
            prev.role === m.role &&
            HEADER_KINDS.has(prev.kind) &&
            m.createdAt - prev.createdAt < 5 * 60_000
          );
        return <MessageItem key={m.id} message={m} agent={agent} showHeader={showHeader} />;
      })}
    </div>
  );
}

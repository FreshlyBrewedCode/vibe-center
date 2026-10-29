import { ArrowUp, Square } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useCancel, useSendMessage } from "@/lib/queries";

/** Enter sends, Shift+Enter is a newline. While the agent is busy, Stop cancels the turn. */
export function Composer({
  conversationId,
  agentName,
  busy,
}: {
  conversationId: string;
  agentName: string;
  busy: boolean;
}) {
  const [text, setText] = useState("");
  const send = useSendMessage(conversationId);
  const cancel = useCancel(conversationId);

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    setText("");
    send.mutate(t, {
      onError: (e) => {
        setText(t);
        toast.error(e.message);
      },
    });
  };

  return (
    <div className="border-t p-3">
      <div className="flex items-end gap-2 rounded-lg border bg-background p-2 focus-within:ring-1 focus-within:ring-ring">
        <Textarea
          autoFocus
          aria-label="Message"
          value={text}
          placeholder={`Message ${agentName}`}
          className="max-h-60 min-h-9 resize-none border-0 p-1 shadow-none focus-visible:ring-0"
          rows={1}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        />
        {busy && (
          <Button
            size="icon"
            variant="outline"
            aria-label="Stop"
            disabled={cancel.isPending}
            onClick={() => cancel.mutate(undefined, { onError: (e) => toast.error(e.message) })}
          >
            <Square className="size-3.5 fill-current" />
          </Button>
        )}
        <Button size="icon" aria-label="Send" disabled={!text.trim()} onClick={submit}>
          <ArrowUp className="size-4" />
        </Button>
      </div>
    </div>
  );
}

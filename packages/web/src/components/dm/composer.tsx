import { Link } from "@tanstack/react-router";
import { AlertTriangle, ArrowUp, Square } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useCancel, useSendMessage } from "@/lib/queries";

/**
 * Enter sends, Shift+Enter is a newline. While the agent is busy, Stop cancels the turn.
 * `harnessDown` disables the composer with a banner pointing at the fix, instead of letting the
 * user send into a harness that will just error.
 */
export function Composer({
  conversationId,
  agentName,
  busy,
  harnessDown,
}: {
  conversationId: string;
  agentName: string;
  busy: boolean;
  harnessDown?: { message: string } | null;
}) {
  const [text, setText] = useState("");
  const send = useSendMessage(conversationId);
  const cancel = useCancel(conversationId);
  const disabled = !!harnessDown;

  const submit = () => {
    const t = text.trim();
    if (!t || disabled) return;
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
      {harnessDown && (
        <div
          data-testid="harness-down-banner"
          className="mb-2 flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
        >
          <AlertTriangle className="size-4 shrink-0 text-destructive" />
          <span className="flex-1">{harnessDown.message}</span>
          <Button asChild variant="outline" size="sm">
            <Link to="/settings/harnesses">Fix in Settings</Link>
          </Button>
        </div>
      )}
      <div
        className={`flex items-end gap-2 rounded-lg border bg-background p-2 focus-within:ring-1 focus-within:ring-ring ${disabled ? "opacity-60" : ""}`}
      >
        <Textarea
          autoFocus
          aria-label="Message"
          value={text}
          disabled={disabled}
          placeholder={disabled ? "The harness is unavailable" : `Message ${agentName}`}
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
        <Button size="icon" aria-label="Send" disabled={disabled || !text.trim()} onClick={submit}>
          <ArrowUp className="size-4" />
        </Button>
      </div>
    </div>
  );
}

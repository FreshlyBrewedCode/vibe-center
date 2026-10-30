import { AlertTriangle, ArrowUp, RefreshCw, Square } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useCancel, useProbeHarness, useSendMessage } from "@/lib/queries";
import { FixInSettingsLink } from "../settings-hint";

/**
 * Enter sends, Shift+Enter is a newline. While the agent is busy, Stop cancels the turn.
 * `harnessIssue` shows a banner pointing at the fix; it only disables sending when `blocking`
 * (not installed, or auth missing) — a cached probe `error` (e.g. a stale timeout at boot) stays
 * visible but doesn't lock the DM, since a real send might still work. Any send failure, or the
 * banner's own button, re-checks the harness's health.
 */
export function Composer({
  conversationId,
  agentName,
  harnessId,
  busy,
  harnessIssue,
}: {
  conversationId: string;
  agentName: string;
  harnessId: string;
  busy: boolean;
  harnessIssue?: { message: string; blocking: boolean } | null;
}) {
  const [text, setText] = useState("");
  const send = useSendMessage(conversationId);
  const cancel = useCancel(conversationId);
  const probe = useProbeHarness();
  const disabled = !!harnessIssue?.blocking;

  const submit = () => {
    const t = text.trim();
    if (!t || disabled) return;
    setText("");
    send.mutate(t, {
      onError: (e) => {
        setText(t);
        toast.error(e.message);
        probe.mutate({ id: harnessId });
      },
    });
  };

  return (
    <div className="border-t p-3">
      {harnessIssue && (
        <div
          data-testid="harness-down-banner"
          className="mb-2 flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
        >
          <AlertTriangle className="size-4 shrink-0 text-destructive" />
          <span className="flex-1">{harnessIssue.message}</span>
          <Button
            variant="outline"
            size="sm"
            disabled={probe.isPending}
            onClick={() => probe.mutate({ id: harnessId })}
          >
            <RefreshCw className={probe.isPending ? "size-3.5 animate-spin" : "size-3.5"} /> Check again
          </Button>
          <FixInSettingsLink hint="settings:harnesses" />
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

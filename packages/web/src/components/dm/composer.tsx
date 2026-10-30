import { AlertTriangle, ArrowUp, RefreshCw, Square } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useIsMobile } from "@/lib/media";
import { useCancel, useProbeHarness, useSendMessage } from "@/lib/queries";
import { cn } from "@/lib/utils";
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
  above,
}: {
  conversationId: string;
  agentName: string;
  harnessId: string;
  busy: boolean;
  harnessIssue?: { message: string; blocking: boolean } | null;
  /** Shown above the input, e.g. what the agent is waiting on. */
  above?: ReactNode;
}) {
  const [text, setText] = useState("");
  const send = useSendMessage(conversationId);
  const cancel = useCancel(conversationId);
  const probe = useProbeHarness();
  const mobile = useIsMobile();
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
    <div className="shrink-0 px-3 pt-2 pb-3 sm:px-10 sm:pb-4">
      <div className="mx-auto w-full max-w-[960px]">
        {harnessIssue && (
          <div
            data-testid="harness-down-banner"
            className="mb-2 flex flex-wrap items-center gap-2 rounded-xl border border-destructive/40 bg-destructive/8 px-3.5 py-2 text-sm"
          >
            <AlertTriangle className="size-4 shrink-0 text-destructive" />
            <span className="min-w-0 flex-1">{harnessIssue.message}</span>
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
        {above}
        <div
          className={cn(
            "elev-sm flex items-end gap-1.5 rounded-2xl border border-line-strong bg-card p-1.5 transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/20 sm:p-2",
            disabled && "opacity-60",
          )}
        >
          <Textarea
            autoFocus={!mobile}
            aria-label="Message"
            value={text}
            disabled={disabled}
            placeholder={disabled ? "The harness is unavailable" : `Message ${agentName}…`}
            className="vc-scroll max-h-60 min-h-9 flex-1 resize-none border-0 bg-transparent px-2.5 py-2 text-[16px] shadow-none focus-visible:ring-0 sm:text-base"
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
              variant="soft"
              size="icon"
              className="rounded-[10px]"
              aria-label="Stop"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate(undefined, { onError: (e) => toast.error(e.message) })}
            >
              <Square className="size-3.5 fill-current" />
            </Button>
          )}
          <Button
            size="icon"
            className="rounded-[10px]"
            aria-label="Send"
            disabled={disabled || !text.trim()}
            onClick={submit}
          >
            <ArrowUp className="size-[18px]" />
          </Button>
        </div>
        {!mobile && (
          <p className="mt-2 px-1 text-muted-foreground text-xs">
            <kbd>⏎</kbd> send · <kbd>⇧⏎</kbd> newline · <kbd>⌘K</kbd> jump
          </p>
        )}
      </div>
    </div>
  );
}

import { Link } from "@tanstack/react-router";
import type { AgentView } from "@vibe-center/shared";
import { Copy, Loader2, Pencil, Play, SquarePen, X } from "lucide-react";
import { toast } from "sonner";
import {
  useAgentTools,
  useCalls,
  useConversation,
  useHarnesses,
  useNewSession,
  useSaveAgent,
} from "@/lib/queries";
import { AgentAvatar, presenceLabel } from "./agent-avatar";
import { HealthBadge } from "./health-badge";
import { Button } from "./ui/button";
import { usePreviewVoice, voiceName } from "./voice/voice-picker";

/**
 * The on-demand details panel for a DM: agent info, current session, model/harness, tools,
 * voice, quick actions.
 */
export function DetailsPanel({ agent, onClose }: { agent: AgentView; onClose: () => void }) {
  const conversation = useConversation(agent.conversationId);
  const harnesses = useHarnesses();
  const harness = harnesses.data?.find((h) => h.id === agent.harnessId);
  const newSession = useNewSession(agent.conversationId);
  const duplicate = useSaveAgent();
  const tools = useAgentTools(agent.id);
  const calls = useCalls();
  const call = calls.data?.find((c) => c.agentId === agent.id && c.state !== "ended");
  const { preview, playing } = usePreviewVoice();
  const session = conversation.data?.sessions.find(
    (s) => s.id === conversation.data.conversation.activeSessionId,
  );

  return (
    <aside className="flex w-80 shrink-0 flex-col overflow-y-auto border-l max-sm:absolute max-sm:inset-y-0 max-sm:right-0 max-sm:z-20 max-sm:w-full max-sm:bg-background">
      <div className="flex h-12 shrink-0 items-center justify-between border-b px-4">
        <h2 className="font-semibold text-sm">Details</h2>
        <Button variant="ghost" size="icon" aria-label="Close details" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </div>
      <div className="space-y-5 p-4">
        <div className="flex items-center gap-3">
          <AgentAvatar avatar={agent.avatar} presence={agent.presence} size="lg" />
          <div className="min-w-0">
            <div className="truncate font-semibold">{agent.name}</div>
            <div className="text-muted-foreground text-xs">{presenceLabel[agent.presence]}</div>
          </div>
        </div>
        {agent.description && <p className="text-muted-foreground text-sm">{agent.description}</p>}

        <Section title="Harness & model">
          <Row label="Harness" value={harness?.name ?? agent.harnessId} />
          {harness && <Row label="Health" value={<HealthBadge health={harness.health} />} />}
          <Row label="Model" value={agent.model ?? "Harness default"} />
          <Row label="Working dir" value={<code className="text-xs">{agent.cwd}</code>} />
        </Section>

        <Section title="Current session">
          {session ? (
            <>
              <Row label="Started" value={new Date(session.startedAt).toLocaleString()} />
              <Row
                label="ACP session"
                value={<code className="text-xs">{session.acpSessionId ?? "—"}</code>}
              />
            </>
          ) : (
            <p className="text-muted-foreground text-xs">No active session yet.</p>
          )}
        </Section>

        <Section title="Tools">
          {tools.data && tools.data.length > 0 ? (
            <div className="space-y-1">
              {tools.data.map((g) => (
                <Row
                  key={g.serverId}
                  label={g.builtin ? "Built-in" : g.serverName}
                  value={
                    g.serverEnabled
                      ? `${g.tools.filter((t) => t.enabled).length} of ${g.tools.length} on`
                      : "server disabled"
                  }
                />
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground text-xs">No tools configured.</p>
          )}
          <Button asChild variant="outline" size="sm" className="justify-start">
            <Link to="/agents/$agentId/edit" params={{ agentId: agent.id }}>
              Edit tools
            </Link>
          </Button>
        </Section>

        <Section title="Voice">
          <Row label="Voice" value={agent.voice ? voiceName(agent.voice) : "Default"} />
          {call && <Row label="Call" value={callStateLabel(call.state)} />}
          <Button
            variant="outline"
            size="sm"
            className="justify-start"
            disabled={playing}
            onClick={() => preview(agent.voice)}
          >
            {playing ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
            Preview voice
          </Button>
        </Section>

        <Section title="Quick actions">
          <div className="flex flex-col gap-2">
            <Button asChild variant="outline" size="sm" className="justify-start">
              <Link to="/agents/$agentId/edit" params={{ agentId: agent.id }}>
                <Pencil className="size-3.5" /> Edit agent
              </Link>
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="justify-start"
              disabled={newSession.isPending}
              onClick={() => newSession.mutate(undefined, { onError: (e) => toast.error(e.message) })}
            >
              <SquarePen className="size-3.5" /> New session
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="justify-start"
              disabled={duplicate.isPending}
              onClick={() =>
                duplicate.mutate(
                  {
                    name: `${agent.name} copy`,
                    description: agent.description,
                    avatar: agent.avatar,
                    systemPrompt: agent.systemPrompt,
                    harnessId: agent.harnessId,
                    model: agent.model,
                    options: agent.options,
                    cwd: agent.cwd,
                    voice: agent.voice,
                  },
                  {
                    onSuccess: () => toast.success(`Duplicated as "${agent.name} copy"`),
                    onError: (e) => toast.error(e.message),
                  },
                )
              }
            >
              <Copy className="size-3.5" /> Duplicate agent
            </Button>
          </div>
        </Section>
      </div>
    </aside>
  );
}

const CALL_STATE_LABELS: Record<string, string> = {
  connecting: "Connecting…",
  listening: "In call · listening",
  thinking: "In call · thinking",
  speaking: "In call · speaking",
};

function callStateLabel(state: string): string {
  return CALL_STATE_LABELS[state] ?? state;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">{title}</h3>
      {children}
    </section>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right">{value}</span>
    </div>
  );
}

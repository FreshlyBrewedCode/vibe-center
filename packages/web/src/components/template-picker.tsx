import { AGENT_TEMPLATES, type AgentTemplate } from "./agent-templates";

/** Step one of agent creation: pick a starting point. Everything it fills in stays editable. */
export function TemplatePicker({ onPick }: { onPick: (template: AgentTemplate) => void }) {
  return (
    <div className="mx-auto w-full max-w-2xl space-y-5 p-6">
      <div>
        <h1 className="font-semibold text-xl">New agent</h1>
        <p className="text-muted-foreground text-sm">Start from a template; everything stays editable.</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {AGENT_TEMPLATES.map((t) => (
          <button
            key={t.id}
            type="button"
            data-testid={`template-${t.id}`}
            onClick={() => onPick(t)}
            className="flex flex-col gap-2 rounded-lg border p-4 text-left transition-colors hover:border-primary hover:bg-accent/50 focus-visible:outline-2 focus-visible:outline-ring"
          >
            <span className="text-2xl">{t.emoji}</span>
            <span className="font-medium text-sm">{t.name}</span>
            <span className="text-muted-foreground text-xs">{t.description}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

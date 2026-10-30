import { AGENT_TEMPLATES, type AgentTemplate } from "./agent-templates";
import { PageHeader } from "./mobile-nav";

/** Step one of agent creation: pick a starting point. Everything it fills in stays editable. */
export function TemplatePicker({ onPick }: { onPick: (template: AgentTemplate) => void }) {
  return (
    <div className="mx-auto w-full max-w-2xl">
      <PageHeader title="New agent" description="Start from a template; everything stays editable." />
      <div className="grid gap-3 px-3 pb-6 sm:grid-cols-3 sm:px-8">
        {AGENT_TEMPLATES.map((t) => (
          <button
            key={t.id}
            type="button"
            data-testid={`template-${t.id}`}
            onClick={() => onPick(t)}
            className="flex flex-col gap-3 rounded-xl border border-line bg-card p-4 text-left transition-colors hover:border-line-strong hover:bg-muted/40 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/30"
          >
            <span className="flex size-10 items-center justify-center rounded-full bg-muted text-xl">
              {t.emoji}
            </span>
            <span className="font-medium text-sm">{t.name}</span>
            <span className="text-muted-foreground text-xs">{t.description}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { AgentForm } from "@/components/agent-form";
import type { AgentTemplate } from "@/components/agent-templates";
import { TemplatePicker } from "@/components/template-picker";

export const Route = createFileRoute("/_app/agents/new")({ component: NewAgent });

function NewAgent() {
  const [template, setTemplate] = useState<AgentTemplate | null>(null);
  return (
    <div className="flex-1 overflow-y-auto">
      {template ? <AgentForm template={template} /> : <TemplatePicker onPick={setTemplate} />}
    </div>
  );
}

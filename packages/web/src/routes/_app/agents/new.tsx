import { createFileRoute } from "@tanstack/react-router";
import { AgentForm } from "@/components/agent-form";

export const Route = createFileRoute("/_app/agents/new")({
  component: () => (
    <div className="flex-1 overflow-y-auto">
      <AgentForm />
    </div>
  ),
});

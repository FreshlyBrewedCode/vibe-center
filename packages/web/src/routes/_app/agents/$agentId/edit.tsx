import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { AgentForm } from "@/components/agent-form";
import { Button } from "@/components/ui/button";
import { useAgent, useDeleteAgent } from "@/lib/queries";

export const Route = createFileRoute("/_app/agents/$agentId/edit")({ component: EditAgent });

function EditAgent() {
  const { agentId } = Route.useParams();
  const agent = useAgent(agentId);
  const del = useDeleteAgent();
  const navigate = useNavigate();
  if (!agent) return null;
  return (
    <div className="flex-1 overflow-y-auto">
      <AgentForm key={agent.id} agent={agent} />
      <div className="mx-auto max-w-2xl px-6 pb-10">
        <Button
          variant="outline"
          className="text-destructive"
          onClick={() => {
            if (!confirm(`Delete ${agent.name} and its whole DM history?`)) return;
            del.mutate(agent.id, {
              onSuccess: () => navigate({ to: "/" }),
              onError: (e) => toast.error(e.message),
            });
          }}
        >
          Delete agent
        </Button>
      </div>
    </div>
  );
}

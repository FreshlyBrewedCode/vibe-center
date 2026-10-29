import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { AgentForm } from "@/components/agent-form";
import { AgentTools } from "@/components/mcp/agent-tools";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
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
      <AgentTools agentId={agent.id} />
      <div className="mx-auto max-w-2xl px-6 pb-10">
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="outline" className="text-destructive">
              Delete agent
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete {agent.name}?</AlertDialogTitle>
              <AlertDialogDescription>
                This deletes its whole DM history too. This can't be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() =>
                  del.mutate(agent.id, {
                    onSuccess: () => navigate({ to: "/" }),
                    onError: (e) => toast.error(e.message),
                  })
                }
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}

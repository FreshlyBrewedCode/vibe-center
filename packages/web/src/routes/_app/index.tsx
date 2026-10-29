import { createFileRoute, Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { useAgents } from "@/lib/queries";

export const Route = createFileRoute("/_app/")({ component: Home });

function Home() {
  const agents = useAgents();
  const empty = agents.data?.length === 0;
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="max-w-sm space-y-4 text-center">
        <h1 className="font-semibold text-xl">{empty ? "Create your first agent" : "Pick an agent"}</h1>
        <p className="text-muted-foreground text-sm">
          Each agent is a persona on a coding harness (Claude Code, OpenCode, any ACP agent). Chat in its DM
          like with a colleague.
        </p>
        {empty && (
          <Button asChild>
            <Link to="/agents/new">New agent</Link>
          </Button>
        )}
      </div>
    </div>
  );
}

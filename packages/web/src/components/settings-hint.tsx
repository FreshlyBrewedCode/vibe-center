import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";

/** A small "Fix in Settings" button for an `ApiError.hint` / error message `hint` like "settings:harnesses". */
export function FixInSettingsLink({ hint }: { hint: string }) {
  switch (hint) {
    case "settings:harnesses":
      return (
        <Button asChild variant="outline" size="sm">
          <Link to="/settings/harnesses">Fix in Settings</Link>
        </Button>
      );
    case "settings:mcp":
      return (
        <Button asChild variant="outline" size="sm">
          <Link to="/settings/mcp">Fix in Settings</Link>
        </Button>
      );
    case "settings:voice":
      return (
        <Button asChild variant="outline" size="sm">
          <Link to="/settings/voice">Fix in Settings</Link>
        </Button>
      );
    default:
      return null;
  }
}

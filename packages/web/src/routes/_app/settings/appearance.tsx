import { createFileRoute } from "@tanstack/react-router";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { setTheme, type Theme, useTheme } from "@/lib/theme";
import { Section } from "../settings";

export const Route = createFileRoute("/_app/settings/appearance")({ component: Appearance });

function Appearance() {
  const theme = useTheme();
  return (
    <Section title="Appearance">
      <Select value={theme} onValueChange={(v) => setTheme(v as Theme)}>
        <SelectTrigger aria-label="Theme" className="w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="system">System</SelectItem>
          <SelectItem value="light">Light</SelectItem>
          <SelectItem value="dark">Dark</SelectItem>
        </SelectContent>
      </Select>
    </Section>
  );
}

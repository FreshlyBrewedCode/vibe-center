import { createFileRoute } from "@tanstack/react-router";
import { Check, Moon, Sun, SunMoon } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { setSidebarMode, useSidebarMode } from "@/lib/sidebar";
import { setTheme, type Theme, useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { Card, Section } from "../settings";

export const Route = createFileRoute("/_app/settings/appearance")({ component: Appearance });

const THEMES: { value: Theme; label: string; icon: typeof Sun; hint: string }[] = [
  { value: "dark", label: "Dark", icon: Moon, hint: "Warm charcoal, the primary look" },
  { value: "light", label: "Light", icon: Sun, hint: "Ivory paper, same structure" },
  { value: "system", label: "System", icon: SunMoon, hint: "Follows the OS setting" },
];

function Appearance() {
  const theme = useTheme();
  const sidebar = useSidebarMode();
  return (
    <>
      <Section title="Theme" description="Dark is the default; pick System to follow the OS.">
        <div className="grid gap-3 sm:grid-cols-3">
          {THEMES.map((t) => {
            const on = theme === t.value;
            return (
              <button
                key={t.value}
                type="button"
                aria-pressed={on}
                onClick={() => setTheme(t.value)}
                className={cn(
                  "flex flex-col gap-3 rounded-xl border bg-card p-4 text-left transition-colors hover:border-line-strong",
                  on ? "border-foreground" : "border-line",
                )}
              >
                <span className="flex items-center justify-between">
                  <t.icon className="size-[18px] text-muted-foreground" />
                  {on && <Check className="size-4" />}
                </span>
                <span>
                  <span className="block font-medium text-sm">{t.label}</span>
                  <span className="block text-muted-foreground text-xs">{t.hint}</span>
                </span>
              </button>
            );
          })}
        </div>
        {/* The select keeps a keyboard/assistive path and the e2e flow; it mirrors the tiles. */}
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
      <Section title="Sidebar" description="On desktop. ⌘\ toggles it anywhere; remembered on this device.">
        <Card className="flex items-center justify-between gap-4 p-4">
          <div>
            <p className="font-medium text-sm">Show names and status</p>
            <p className="mt-0.5 text-muted-foreground text-xs">
              Off: an icon rail of avatars with presence rings; hover for the name.
            </p>
          </div>
          <Select value={sidebar} onValueChange={(v) => setSidebarMode(v as "rail" | "expanded")}>
            <SelectTrigger aria-label="Sidebar" className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="rail">Icon rail</SelectItem>
              <SelectItem value="expanded">Expanded</SelectItem>
            </SelectContent>
          </Select>
        </Card>
      </Section>
    </>
  );
}

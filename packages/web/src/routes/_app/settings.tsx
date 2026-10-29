import { createFileRoute, Link, Outlet } from "@tanstack/react-router";

/**
 * Settings layout: a nav plus one child route per section (settings/<section>.tsx). Each phase
 * adds its own section file and one line in SECTIONS, so parallel work doesn't collide.
 */
const SECTIONS = [
  { to: "/settings/general", label: "General" },
  { to: "/settings/harnesses", label: "Harnesses" },
  { to: "/settings/mcp", label: "MCP servers" },
  { to: "/settings/devices", label: "Devices" },
  { to: "/settings/appearance", label: "Appearance" },
] as const;

export const Route = createFileRoute("/_app/settings")({ component: SettingsLayout });

function SettingsLayout() {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-6 p-6">
        <h1 className="font-semibold text-xl">Settings</h1>
        <nav className="flex gap-1 border-b">
          {SECTIONS.map((s) => (
            <Link
              key={s.to}
              to={s.to}
              className="-mb-px border-transparent border-b-2 px-3 py-2 text-muted-foreground text-sm hover:text-foreground"
              activeProps={{ className: "border-foreground! text-foreground!" }}
            >
              {s.label}
            </Link>
          ))}
        </nav>
        <Outlet />
      </div>
    </div>
  );
}

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="font-medium text-muted-foreground text-sm">{title}</h2>
      {children}
    </section>
  );
}

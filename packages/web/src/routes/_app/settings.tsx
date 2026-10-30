import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { PageHeader } from "@/components/mobile-nav";
import { cn } from "@/lib/utils";

/**
 * Settings layout: a nav plus one child route per section (settings/<section>.tsx). Each phase
 * adds its own section file and one line in SECTIONS, so parallel work doesn't collide.
 */
const SECTIONS = [
  { to: "/settings/general", label: "General" },
  { to: "/settings/harnesses", label: "Harnesses" },
  { to: "/settings/mcp", label: "MCP servers" },
  { to: "/settings/voice", label: "Voice" },
  { to: "/settings/devices", label: "Devices" },
  { to: "/settings/appearance", label: "Appearance" },
] as const;

export const Route = createFileRoute("/_app/settings")({ component: SettingsLayout });

function SettingsLayout() {
  return (
    <div className="vc-scroll flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl">
        <PageHeader title="Settings" />
        <nav className="vc-noscroll mx-3 flex gap-1 overflow-x-auto border-line border-b sm:mx-8">
          {SECTIONS.map((s) => (
            <Link
              key={s.to}
              to={s.to}
              className="-mb-px shrink-0 border-transparent border-b-2 px-3 py-2.5 text-muted-foreground text-sm transition-colors hover:text-foreground"
              activeProps={{ className: "border-foreground! text-foreground! font-medium" }}
            >
              {s.label}
            </Link>
          ))}
        </nav>
        <div className="space-y-8 px-3 py-6 sm:px-8">
          <Outlet />
        </div>
      </div>
    </div>
  );
}

/** A settings section: an uppercase label and its content. */
export function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="vc-label">{title}</h2>
        {description && <p className="mt-1 text-muted-foreground text-sm">{description}</p>}
      </div>
      {children}
    </section>
  );
}

/** The card surface settings rows and forms sit on. */
export function Card({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("rounded-xl border border-line bg-card", className)}>{children}</div>;
}

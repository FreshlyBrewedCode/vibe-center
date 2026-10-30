import { CircleCheckIcon, InfoIcon, Loader2Icon, OctagonXIcon, TriangleAlertIcon } from "lucide-react";
import { Toaster as Sonner, type ToasterProps } from "sonner";
import { useTheme } from "@/lib/theme";

/** Toasts on the card surface at elevation 3, matching dialogs and the call card. */
const Toaster = ({ ...props }: ToasterProps) => {
  const theme = useTheme();

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4 text-presence-working" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4 text-presence-waiting" />,
        error: <OctagonXIcon className="size-4 text-destructive" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      toastOptions={{
        classNames: {
          toast: "elev! border-line-strong! font-sans! text-[13px]!",
          description: "text-muted-foreground!",
          actionButton: "bg-primary! text-primary-foreground! rounded-lg! font-medium!",
          cancelButton: "bg-muted! text-foreground! rounded-lg!",
        },
      }}
      style={
        {
          "--normal-bg": "var(--card)",
          "--normal-text": "var(--card-foreground)",
          "--normal-border": "var(--line-strong)",
          "--border-radius": "14px",
        } as React.CSSProperties
      }
      {...props}
    />
  );
};

export { Toaster };

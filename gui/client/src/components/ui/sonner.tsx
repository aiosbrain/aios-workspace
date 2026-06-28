import { Toaster as Sonner, type ToasterProps } from "sonner";

/**
 * App toast surface. Themed via design tokens so it matches light/dark automatically
 * (the `.dark` class on <html> flips the CSS vars). Mount once near the app root.
 */
function Toaster(props: ToasterProps) {
  return (
    <Sonner
      className="toaster group"
      style={
        {
          "--normal-bg": "var(--aios-elevated)",
          "--normal-text": "var(--aios-fg)",
          "--normal-border": "var(--aios-border-visible)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast:
            "rounded-xl border border-border bg-popover text-popover-foreground shadow-overlay",
          description: "text-muted-foreground",
          actionButton: "rounded-md bg-primary text-primary-foreground",
          cancelButton: "rounded-md bg-muted text-muted-foreground",
        },
      }}
      {...props}
    />
  );
}

export { Toaster };
export { toast } from "sonner";

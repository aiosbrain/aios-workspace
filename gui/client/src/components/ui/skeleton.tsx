import { cn } from "../../lib/cn";

/** Loading placeholder. Honors prefers-reduced-motion via the global stylesheet. */
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("animate-pulse rounded-md bg-muted", className)} {...props} />;
}

export { Skeleton };

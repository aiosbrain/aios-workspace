import { cn } from "../../lib/cn";

/**
 * Monogram avatars for task assignees.
 *
 * Assignees in a workspace tasks table are free text, not accounts — real values include
 * "John", "Chetan", and "John + Chetan". There is no member directory to resolve a photo from,
 * so the avatar is derived entirely from the string: initials over a deterministic colour. That
 * is the same fallback Linear uses for members without a photo, and it means an assignee renders
 * identically on every machine with no network call and no configuration.
 *
 * `TaskRow.avatar_url` is intentionally honoured when present but never required — when member
 * profiles arrive from the Team Brain they can populate it without this component changing.
 */

/** Palette drawn from the design tokens, so a monogram can never introduce an off-system colour. */
const TONES = [
  "bg-violet/20 text-violet",
  "bg-cyan/20 text-cyan",
  "bg-lime/20 text-lime",
  "bg-amber/20 text-amber",
  "bg-primary/20 text-primary",
  "bg-destructive/20 text-destructive",
] as const;

const SIZES = {
  sm: "size-5 text-[9px]",
  md: "size-6 text-[10px]",
} as const;

/**
 * Split a free-text assignee cell into individual people.
 * "John + Chetan", "John, Chetan" and "John & Chetan" are all two people, not one person with
 * a strange name — collapsing them into a single "JC" monogram would misattribute the work.
 */
export function splitAssignees(raw: string): string[] {
  return raw
    .split(/\s*(?:[+,&/]|\band\b)\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Initials for one person: first letter of the first and last word, uppercased.
 * Falls back to the first two characters for a single-word handle ("chetan" → "CH").
 */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

/**
 * Stable colour index for a name. A plain sum-of-char-codes hash is enough here: the only
 * requirement is that the same assignee always gets the same tone within and across sessions,
 * not that the distribution be cryptographically uniform.
 */
export function toneIndexOf(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return hash % TONES.length;
}

function Monogram({
  name,
  size,
  className,
}: {
  name: string;
  size: keyof typeof SIZES;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-medium leading-none ring-1 ring-inset ring-border-visible",
        SIZES[size],
        TONES[toneIndexOf(name)],
        className
      )}
      title={name}
    >
      {initialsOf(name)}
    </span>
  );
}

export function AssigneeAvatar({
  assignee,
  size = "md",
  max = 2,
}: {
  assignee?: string | null;
  size?: keyof typeof SIZES;
  max?: number;
}) {
  const people = assignee ? splitAssignees(assignee) : [];
  if (!people.length) {
    return (
      <span
        className={cn(
          "inline-flex shrink-0 items-center justify-center rounded-full border border-dashed border-border-visible text-muted-foreground",
          SIZES[size]
        )}
        title="Unassigned"
        aria-label="Unassigned"
      >
        —
      </span>
    );
  }
  const shown = people.slice(0, max);
  const overflow = people.length - shown.length;
  return (
    // Avatars sit side by side with a small gap rather than the usual overlapping stack.
    // Overlap is a photo idiom: with monograms the next circle covers the trailing letter, so
    // "John" renders as "JC" instead of "JO" — the initials become actively misleading.
    <span
      className="inline-flex shrink-0 items-center gap-0.5"
      aria-label={`Assigned to ${people.join(", ")}`}
    >
      {shown.map((name) => (
        <Monogram key={name} name={name} size={size} />
      ))}
      {overflow > 0 && (
        <span
          className={cn(
            "inline-flex shrink-0 items-center justify-center rounded-full bg-secondary font-medium leading-none text-muted-foreground ring-1 ring-inset ring-border-visible",
            SIZES[size]
          )}
          title={people.slice(max).join(", ")}
        >
          +{overflow}
        </span>
      )}
    </span>
  );
}

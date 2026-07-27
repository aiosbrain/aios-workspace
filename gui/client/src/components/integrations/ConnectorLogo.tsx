import { siJira, siLinear, siNotion, siPlane } from "simple-icons";

/** Minimal shape of a simple-icons entry (avoids depending on the package's exported type). */
type BrandIcon = { title: string; path: string };

// Connector id → brand icon. Logos are inlined from `simple-icons` SVG path data —
// NO network/CDN request (the cockpit is localhost-only and privacy-preserving).
// Brands simple-icons no longer ships (Slack was removed; Firecrawl + Granola were
// never present) fall through to a monogram tile.
const BRAND: Record<string, BrandIcon> = {
  jira: siJira,
  linear: siLinear,
  notion: siNotion,
  plane: siPlane,
};

// Stable per-connector accent for the monogram fallback, drawn from design tokens
// (never a hardcoded hex). Color is carried via currentColor so both modes stay legible.
const TONES = ["violet", "cyan", "amber", "emerald", "fuchsia"] as const;
function tone(id: string): (typeof TONES)[number] {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return TONES[h % TONES.length];
}

const TONE_CLASS: Record<(typeof TONES)[number], string> = {
  violet: "text-violet",
  cyan: "text-cyan",
  amber: "text-amber",
  emerald: "text-emerald",
  fuchsia: "text-fuchsia",
};

/**
 * Brand logo for a connector card. Renders a real brand glyph when `simple-icons`
 * ships one, otherwise a tinted monogram tile. The brand glyph uses `currentColor`
 * (not the brand's hardcoded hex) so dark mode stays legible.
 */
export function ConnectorLogo({
  id,
  name,
  className = "",
}: {
  id: string;
  name: string;
  className?: string;
}) {
  const icon = BRAND[id];
  const base = `flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border ${className}`;

  if (icon) {
    return (
      <span className={`${base} bg-muted text-foreground`} aria-hidden="true">
        <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current" role="img">
          <title>{icon.title}</title>
          <path d={icon.path} />
        </svg>
      </span>
    );
  }

  const letter = (name || id).trim().charAt(0).toUpperCase() || "?";
  return (
    <span
      className={`${base} bg-muted font-sans text-lg leading-none ${TONE_CLASS[tone(id)]}`}
      aria-hidden="true"
    >
      {letter}
    </span>
  );
}

/**
 * spec-checks/spec-text.mjs — pure text/path helpers over a spec's markdown. Extracted VERBATIM
 * from scripts/spec-eval.mjs (AIO-594, devtools-lane decoupling); the only change is that
 * extractBullets/collectAcceptanceBullets/pathResolves/findArchitectureClaims are now exported for
 * the deterministic.mjs sibling (they were module-private before the split). Import via the
 * scripts/spec-checks.mjs barrel (R1).
 */

import { existsSync } from "node:fs";
import path from "node:path";

// ── text helpers ────────────────────────────────────────────────────────────────────────────

/** Split a spec into markdown sections { heading, level, body }. Content before the first
 *  heading is a section with an empty heading (the preamble). */
export function extractSections(specText) {
  const lines = String(specText).split("\n");
  const sections = [];
  let current = { heading: "", level: 0, body: "" };
  for (const line of lines) {
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      sections.push(current);
      current = { heading: h[2].trim(), level: h[1].length, body: "" };
    } else {
      current.body += line + "\n";
    }
  }
  sections.push(current);
  return sections;
}

export function extractBullets(body) {
  const out = [];
  for (const line of String(body).split("\n")) {
    const m = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/);
    if (m && m[1].trim()) out.push(m[1].trim());
  }
  return out;
}

/** Bullets under ## Acceptance criteria plus ### Automated/Manual/Visual child sections. */
export function collectAcceptanceBullets(sections) {
  const accIdx = sections.findIndex((s) =>
    /\b(accept|success crit|done when|definition of done|acceptance)\b/i.test(s.heading)
  );
  if (accIdx < 0) return [];
  const accLevel = sections[accIdx].level || 2;
  const bullets = extractBullets(sections[accIdx].body);
  for (let i = accIdx + 1; i < sections.length; i++) {
    const s = sections[i];
    if (s.level > 0 && s.level <= accLevel) break;
    if (s.level > accLevel) bullets.push(...extractBullets(s.body));
  }
  return bullets;
}

const VAGUE_RE =
  /\b(works?\s*(well)?|is\s+fast|blazing|good|great|nice(ly)?|properly|correct(ly)?|robust|clean|solid|reasonable|as expected|makes sense|user-?friendly|intuitive|smooth|feels?\s+\w+|seamless)\b/i;
const CONCRETE_RE =
  /(\bexit(s|ed)?\s*(code\s*)?\d|\breturns?\b|=>|->|\bprints?\b|\boutputs?\b|\bwrites?\b|\bpass(es|ed)?\b|\bassert\w*\b|\bregex\b|\bhttp\s*\d|\bstatus\s*\d|\b\d{2,}\b|--\w+|`[^`]+`|\.(ts|mjs|js|json|md|sh)\b|\bwhen\b[^.\n]*\bthen\b|\bgiven\b[^.\n]*\bwhen\b|\btest\b)/i;

/** Heuristic: is an acceptance criterion observable — does it name a concrete, checkable
 *  signal (exit code, output, named test, command, number) rather than a vibe ("works well")? */
export function looksObservable(text) {
  const t = String(text ?? "").trim();
  if (!t) return false;
  if (!CONCRETE_RE.test(t)) return false;
  // Concrete signal present, but if the sentence is dominated by a vague qualifier with no
  // other substance, still treat it as vague (defends against "works, and fast — 100% good").
  const stripped = t.replace(CONCRETE_RE, "").trim();
  if (VAGUE_RE.test(t) && stripped.replace(VAGUE_RE, "").replace(/[\s,.;:]+/g, "").length < 3) {
    return false;
  }
  return true;
}

const SYNC_SURFACE_RE =
  /\b(the brain|team brain|to the brain|from the brain|aios push|aios pull|\/api\/v1|brain[ -]?api|syncs?\s+(to|outward|upward|the)|synced to|tier-?tagged push|push(es|ed|ing)?\s+(to\s+)?the\s+brain)\b/i;

/** Does the spec touch a sync/brain surface (the SR7 trigger)? */
export function touchesSyncSurface(specText) {
  return SYNC_SURFACE_RE.test(String(specText));
}

const KNOWN_EXT_RE = /\.(ts|tsx|mjs|cjs|js|jsx|json|md|sh|yaml|yml|py|txt)$/i;

function isPathCandidate(s) {
  if (!s) return false;
  if (/[*<>\s]/.test(s)) return false; // glob / <placeholder> / multi-word
  if (s.includes("://")) return false; // url
  if (s.includes("/") && /^[\w./@-]+$/.test(s) && KNOWN_EXT_RE.test(s)) return true; // path with ext
  if (!s.includes("/") && /^[\w.-]+$/.test(s) && KNOWN_EXT_RE.test(s)) return true; // bare filename.ext
  return false;
}

function normalizePath(p) {
  return String(p)
    .replace(/^\.\//, "")
    .replace(/[.,;:)]+$/, "");
}

function backtickSpans(line) {
  const out = [];
  const re = /`([^`]+)`/g;
  let m;
  while ((m = re.exec(line))) out.push(m[1].trim());
  return out;
}

/** Find file-path references in a spec, tagged with the section + line context they appear in.
 *  Globs and <placeholder> paths are excluded. */
export function findReferencedPaths(specText) {
  const lines = String(specText).split("\n");
  const refs = [];
  let heading = "";
  lines.forEach((line, i) => {
    const h = line.match(/^#{1,6}\s+(.*)$/);
    if (h) {
      heading = h[1].trim();
      return;
    }
    for (const span of backtickSpans(line)) {
      if (isPathCandidate(span)) {
        refs.push({ path: normalizePath(span), line: i + 1, section: heading, lineText: line });
      }
    }
  });
  return refs;
}

export function pathResolves(repo, p) {
  if (!repo) return true; // no repo to resolve against — do not manufacture a blocker
  return existsSync(path.join(repo, p));
}

/** Classify the context an unresolved path appears in (SR3 section-awareness):
 *  'existing' → a hard blocker (named as existing code), 'new'/'ambiguous' → advisory. */
export function classifyPathContext(ref) {
  const heading = ref.section || "";
  const text = ref.lineText || "";

  // The LINE wins over the HEADING (AIO-573). This order used to be reversed, and the effect was
  // that `## Interface / integration points` — which contains "integrat" — classified EVERY path
  // under it as existing code. Naming a file the slice is about to create therefore became a hard
  // blocker in the one section specs naturally name files in, and the shipped issue template told
  // authors to write `new file: …` in exactly that section. An author following our own template
  // was guaranteed a false blocker. The author's explicit statement about a specific path is
  // better evidence than the section it happens to sit under.
  // Markers are scoped to the NEAREST one preceding this specific path, not applied to the whole
  // line. One bullet can legitimately mix both roles —
  //   - new file: `scripts/ui/out.mjs` — integrates with `scripts/phantom.mjs`
  // — and a whole-line rule would let the "new file" marker launder the phantom integration
  // target down to an advisory. Each path is judged by the claim actually attached to it.
  const at = ref.path ? text.indexOf(ref.path) : -1;
  const scope = at >= 0 ? text.slice(0, at) : text;
  const lastIndexOfMatch = (re, s) => {
    let idx = -1;
    for (const m of s.matchAll(re)) idx = m.index;
    return idx;
  };
  const NEW_MARK = /\b(new\s+file|creates?|to\s+create|does\s+not\s+exist|not\s+present)\b/gi;
  const OLD_MARK =
    /\b(reuses?|extends?|builds?\s+on|based\s+on|integrat\w*|existing|modif\w*|already\s+in)\b/gi;
  const newAt = lastIndexOfMatch(NEW_MARK, scope);
  const oldAt = lastIndexOfMatch(OLD_MARK, scope);
  if (newAt >= 0 || oldAt >= 0) return newAt > oldAt ? "new" : "existing";

  // A marker may also be written as a predicate after the path (`foo.mjs` does not exist yet,
  // `bar.mjs` extends the existing dispatcher). Only consult this suffix when no leading marker
  // classified the path: on a mixed-role line, the next leading marker belongs to the next path.
  if (at >= 0) {
    const pathEnd = at + ref.path.length;
    const afterPath = text.slice(pathEnd + (text[pathEnd] === "`" ? 1 : 0));
    const nextPath = afterPath.indexOf("`");
    const suffix = nextPath >= 0 ? afterPath.slice(0, nextPath) : afterPath;
    const suffixNewAt = lastIndexOfMatch(NEW_MARK, suffix);
    const suffixOldAt = lastIndexOfMatch(OLD_MARK, suffix);
    if (suffixNewAt >= 0 || suffixOldAt >= 0) {
      return suffixNewAt > suffixOldAt ? "new" : "existing";
    }
  }

  // A spec may legitimately reference a real path in ANOTHER repository — a cross-repo contract
  // change names files in its sibling. Those cannot resolve here, and blocking on them pushed
  // authors to delete precise paths in favour of vague prose, degrading the spec to satisfy the
  // check. External sections are advisory.
  if (/\b(upstream|external|sibling|other\s+repo|another\s+repo)/i.test(heading)) return "new";

  if (/\b(reuse|integrat|builds?\s+on|extend|existing|modif|touch)/i.test(heading)) {
    return "existing";
  }
  if (
    /\b(implement|task|step|new\s+file|create|scaffold)/i.test(heading) ||
    /\b(adds?\b|writes?\b|scaffold|stub)\b/i.test(text)
  ) {
    return "new";
  }
  return "ambiguous";
}

export function findArchitectureClaims(specText) {
  const lines = String(specText).split("\n");
  const claims = [];
  lines.forEach((line, i) => {
    if (!/\b(reuses?|extends?|builds?\s+on|based\s+on)\b/i.test(line)) return;
    const paths = backtickSpans(line).filter(isPathCandidate).map(normalizePath);
    if (paths.length) claims.push({ text: line.trim(), paths, line: i + 1 });
  });
  return claims;
}

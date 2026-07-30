/**
 * catalog.mjs — GUI-owned catalog + personality helpers (AIO-600, GUI decoupling).
 *
 * The GUI no longer deep-imports scripts/gen-catalog.mjs. Skills + integrations now
 * arrive through the CLI seam (`aios catalog --json`, see index.mjs) and this module
 * only shapes that payload for the client; personalities are a GUI-only concept, so
 * their scan lives here, parsing frontmatter via the published workspace-parse hub.
 *
 * Pure + side-effect-free (fs reads only) so it unit-tests directly, mirroring
 * tasks.mjs / maturity.mjs.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "@aiosbrain/foundation/workspace-parse";

// Provenance: copied from scripts/gen-catalog.mjs `firstSentence` (AIO-600) — a
// 4-line stable display helper; not worth a package subpath or a CLI round-trip.
export function firstSentence(s = "") {
  const clean = s.replace(/\s+/g, " ").trim();
  const dot = clean.indexOf(". ");
  return dot === -1 ? clean : clean.slice(0, dot + 1);
}

/**
 * Scan .claude/personalities/ → [{ id, name, description }]. id is the filename
 * stem (constrained to safe chars by the scan); used by the picker + to validate a
 * personality write. Personality frontmatter is flat key: value, so the shared
 * flat-YAML parser is sufficient (SKILL.md's block scalars never appear here).
 */
export function listPersonalities(repoDir) {
  const dir = path.join(repoDir, ".claude", "personalities");
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith(".md")) continue;
    const id = f.replace(/\.md$/, "");
    if (!/^[a-z0-9-]+$/.test(id)) continue;
    let fm = {};
    try {
      fm = parseFrontmatter(readFileSync(path.join(dir, f), "utf8")).frontmatter || {};
    } catch {
      /* skip */
    }
    out.push({ id, name: fm.name || id, description: firstSentence(fm.description || "") });
  }
  return out;
}

/**
 * Shape the /api/blueprint response from the `aios pull blueprint` outcome and the
 * `aios connector blueprint` seam envelope. A non-200 envelope (failed spawn,
 * non-envelope output, engine error) propagates AS that status + error body — it
 * must never be flattened into a 200 with `connectors: []`, which would read as
 * "no connectors" instead of "the seam failed" (Bugbot on #499). The `?? []`
 * default applies only to a genuine 200 with an absent/empty list.
 */
export function blueprintResponse(pullFailed, pullNote, { status, body }) {
  if (status !== 200) return { status, body };
  return {
    status: 200,
    body: {
      ok: !pullFailed,
      blueprint: body.blueprint ?? null,
      connectors: body.connectors ?? [],
      note: pullFailed ? pullNote : null,
    },
  };
}

/**
 * Shape one `aios catalog --json` document for the GUI: skills reduced to the
 * card fields, integrations passed through. Tolerates a malformed payload by
 * returning an empty catalog (the client renders an empty state, not a crash).
 */
export function mapCatalog(raw) {
  const skills = (Array.isArray(raw?.skills) ? raw.skills : []).map((s) => ({
    name: s.name,
    kind: s.kind,
    description: firstSentence(s.description),
  }));
  return { skills, integrations: Array.isArray(raw?.integrations) ? raw.integrations : [] };
}

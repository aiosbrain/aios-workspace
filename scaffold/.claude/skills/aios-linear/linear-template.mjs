import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Resolve aios-issue-template from toolkit docs or workspace copy. */
export function resolveLinearTemplate(name = "aios") {
  if (name !== "aios" && name !== "pick-up-able") return null;
  const rel = path.join("docs", "agentic-ergonomics", "aios-issue-template.md");
  const candidates = [
    path.join(HERE, "..", "..", "..", rel),
    path.join(HERE, "..", "..", "..", "..", rel),
    path.join(process.cwd(), rel),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return readFileSync(p, "utf8");
  }
  return null;
}

/** Apply SEARCH/REPLACE patch blocks to description text. */
export function applyDescriptionPatch(original, patchText) {
  const blockRe = /<<<<<<< SEARCH\r?\n([\s\S]*?)\r?\n=======\r?\n([\s\S]*?)\r?\n>>>>>>> REPLACE/g;
  let text = original;
  let count = 0;
  let m;
  while ((m = blockRe.exec(patchText)) !== null) {
    const search = m[1];
    const replace = m[2];
    if (!search) {
      throw new Error("patch SEARCH block is empty");
    }
    if (!text.includes(search)) {
      throw new Error(`patch SEARCH block not found in description (${search.slice(0, 60)}…)`);
    }
    text = text.replace(search, () => replace);
    count++;
  }
  if (!count) {
    throw new Error("patch file has no <<<<<<< SEARCH / ======= / >>>>>>> REPLACE blocks");
  }
  return text;
}

/* ─────────────────── description round-trip integrity (AIO-942) ───────────────────
 *
 * Linear does not store a description as the markdown you send it. It parses to its own
 * document model and re-serialises, and that round trip is NOT lossless:
 *
 *   1. YAML frontmatter (`---` … `---`) comes back as a ```yaml fence.
 *   2. Emphasis is re-bracketed around inline code — `**not `x` icon**` becomes
 *      `**not** `x` **icon**`.
 *   3. A markdown table INDENTED under a list item is CORRUPTED: leading characters are
 *      stripped from every cell after the first column. Observed on VIB-348, 2026-08-19 —
 *      `| I2 (#8) | `components/…` | `CircleX` |` came back as
 *      `| (#8) | mponents/…` | rcleX` |`. That is stored text, not a rendering artifact.
 *
 * (1) and (2) are cosmetic and reversible. (3) silently DELETES content. The danger is that
 * a byte-compare cannot tell them apart, so `verify-desc` failed on essentially every write
 * and became noise nobody could act on — which is exactly how (3) nearly shipped unnoticed.
 *
 * So: compare on a normalised form that absorbs (1) and (2), leaving any residual difference
 * as real content drift worth failing on.
 */

/** Split `md` into lines, marking which are inside a fenced code block. */
function markFences(md) {
  const lines = md.split("\n");
  let fence = null;
  return lines.map((line) => {
    const m = /^\s*(`{3,}|~{3,})/.exec(line);
    if (m) {
      if (fence == null) {
        fence = m[1][0];
        return { line, fenced: true };
      }
      if (m[1][0] === fence) {
        fence = null;
        return { line, fenced: true };
      }
    }
    return { line, fenced: fence != null };
  });
}

/**
 * Canonical form for comparing a description we sent against what Linear stored.
 * Absorbs Linear's known cosmetic rewrites; preserves every visible character, so
 * dropped or mangled content still shows up as a difference.
 */
export function normalizeForCompare(md) {
  let out = String(md ?? "");
  // (1) YAML frontmatter ↔ ```yaml fence — reduce both to a bare fence marker.
  out = out.replace(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/, (_m, body) => "```yaml\n" + body + "\n```\n");
  // (2) emphasis markers carry no content — strip them wholesale.
  out = out.replace(/\*\*/g, "").replace(/(^|\W)[*_](\S)/g, "$1$2").replace(/(\S)[*_](\W|$)/g, "$1$2");
  // table delimiter rows: `|---|---|` and `| -- | -- |` are the same row.
  out = out
    .split("\n")
    .map((l) => (/^\s*\|[\s:|-]+\|\s*$/.test(l) ? "|---|" : l))
    .join("\n");
  // whitespace: Linear re-indents and re-wraps freely.
  out = out.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{2,}/g, "\n");
  return out.trim();
}

/**
 * Locate markdown tables indented under a list item — the shape Linear corrupts.
 * Returns `[{ line, text }]`, 1-indexed, empty when clean. Rows inside code fences
 * are ignored: a fenced example of the bug is not the bug.
 */
export function findIndentedTables(md) {
  const hits = [];
  markFences(md).forEach(({ line, fenced }, i) => {
    if (fenced) return;
    // a table row that does not start at column 0
    if (/^[ \t]+\|.*\|[ \t]*$/.test(line)) hits.push({ line: i + 1, text: line.trim() });
  });
  return hits;
}

/**
 * Compare what we sent against what Linear stored, ignoring its cosmetic rewrites.
 * Returns `null` when they agree, else `{ at, local, remote }` around the first real
 * divergence — `at` being the offset into the normalised text, for orientation only.
 */
export function describeContentDrift(local, remote) {
  const a = normalizeForCompare(local);
  const b = normalizeForCompare(remote);
  if (a === b) return null;
  let at = 0;
  while (at < a.length && at < b.length && a[at] === b[at]) at++;
  const from = Math.max(0, at - 60);
  return {
    at,
    local: a.slice(from, at + 120),
    remote: b.slice(from, at + 120),
  };
}

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const TEMPLATE_FILES = {
  aios: "aios-issue-template.md",
  "pick-up-able": "aios-issue-template.md",
  // Finding-shaped variant (AIO-999): post-merge findings classified at file time.
  finding: "aios-finding-template.md",
};

/** Resolve an issue template from toolkit docs or workspace copy. */
export function resolveLinearTemplate(name = "aios") {
  const file = TEMPLATE_FILES[name];
  if (!file) return null;
  const rel = path.join("docs", "agentic-ergonomics", file);
  // cwd first so a scaffolded workspace's stamped template copy wins over the toolkit's
  // (the adapter always executes from the toolkit checkout, even when delegated to from a
  // workspace — AIO-1067); the toolkit's own docs/ copy is the fallback everywhere else.
  const candidates = [path.join(process.cwd(), rel), path.join(HERE, "..", "..", "..", rel)];
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
    if (fence != null) {
      const quote = blockquoteLineInfo(line);
      if (quote.depth < fence.quoteDepth) {
        // A fenced block inside a quote ends when that quote container ends.
        fence = null;
      } else {
        // Strip only the quote container that owns the fence. Any deeper `>` is code.
        const content = blockquoteLineInfo(line, fence.quoteDepth).content;
        const closing = /^[ \t]*(`+|~+)[ \t]*$/.exec(content);
        if (closing && closing[1][0] === fence.marker && closing[1].length >= fence.length) {
          fence = null;
        }
        return { line, fenced: true };
      }
    }
    const { content, depth: quoteDepth } = blockquoteLineInfo(line);
    const opening = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(content);
    if (opening && !(opening[1][0] === "`" && opening[2].includes("`"))) {
      fence = { marker: opening[1][0], length: opening[1].length, quoteDepth };
      return { line, fenced: true };
    }
    return { line, fenced: false };
  });
}

/** Apply a prose-only transform without touching inline code spans. */
function mapOutsideCodeSpans(line, transform) {
  const spans = [];
  let masked = "";
  let chunkStart = 0;
  let cursor = 0;
  while (cursor < line.length) {
    if (line[cursor] !== "`") {
      cursor++;
      continue;
    }
    let ticks = 1;
    while (line[cursor + ticks] === "`") ticks++;
    const marker = "`".repeat(ticks);
    const close = line.indexOf(marker, cursor + ticks);
    if (close === -1) break;
    masked += line.slice(chunkStart, cursor);
    const token = `\u0000CODE${spans.length}\u0000`;
    spans.push(line.slice(cursor, close + ticks));
    masked += token;
    cursor = close + ticks;
    chunkStart = cursor;
  }
  masked += line.slice(chunkStart);
  // NUL sentinels cannot occur in markdown input, so the control characters are deliberate.
  // eslint-disable-next-line no-control-regex
  const sentinel = /\u0000CODE(\d+)\u0000/g;
  return transform(masked).replace(sentinel, (_match, index) => spans[Number(index)]);
}

/** Remove paired asterisk emphasis delimiters while preserving literal stars and underscores. */
function normalizeEmphasis(text) {
  const boundaryBefore = String.raw`(^|[\s([{"'>.,;:!?-])`;
  const boundaryAfter = String.raw`(?=$|[\s)\]}"'<>.,;:!?-])`;
  const strong = new RegExp(
    `${boundaryBefore}\\*\\*(?![*/.])(?=\\S)([^\\n]*?\\S)\\*\\*${boundaryAfter}`,
    "g"
  );
  const emphasis = new RegExp(
    `${boundaryBefore}\\*(?![*/.])(?=\\S)([^*\\n]*?\\S)\\*${boundaryAfter}`,
    "g"
  );
  let previous;
  do {
    previous = text;
    text = text.replace(strong, "$1$2").replace(emphasis, "$1$2");
  } while (text !== previous);
  return text;
}

/** Split a table row on pipes outside escaped text and inline code. */
function splitTableCells(line) {
  let content = line.trim();
  if (content.startsWith("|")) content = content.slice(1);
  if (content.endsWith("|")) content = content.slice(0, -1);
  const cells = [];
  let cell = "";
  let codeTicks = 0;
  for (let cursor = 0; cursor < content.length; cursor++) {
    if (content[cursor] === "\\" && cursor + 1 < content.length) {
      cell += content.slice(cursor, cursor + 2);
      cursor++;
      continue;
    }
    if (content[cursor] === "`") {
      let ticks = 1;
      while (content[cursor + ticks] === "`") ticks++;
      if (codeTicks === 0) codeTicks = ticks;
      else if (ticks === codeTicks) codeTicks = 0;
      cell += "`".repeat(ticks);
      cursor += ticks - 1;
      continue;
    }
    if (content[cursor] === "|" && codeTicks === 0) {
      cells.push(cell.trim());
      cell = "";
      continue;
    }
    cell += content[cursor];
  }
  cells.push(cell.trim());
  return cells.length >= 2 ? cells : null;
}

/** Canonicalize delimiter styling while preserving column count and alignment. */
function normalizeTableDelimiter(line) {
  const cells = splitTableCells(line);
  if (!cells || cells.some((cell) => !/^:?-+:?$/.test(cell))) return null;
  const canonical = cells.map((cell) => {
    const left = cell.startsWith(":") ? ":" : "";
    const right = cell.endsWith(":") ? ":" : "";
    return `${left}---${right}`;
  });
  return `|${canonical.join("|")}|`;
}

/** Read up to `maxDepth` Markdown blockquote markers and retain inner indentation. */
function blockquoteLineInfo(line, maxDepth = Infinity) {
  let content = line;
  let depth = 0;
  while (depth < maxDepth) {
    const marker = /^[ \t]{0,3}>[ \t]?/.exec(content);
    if (!marker) break;
    content = content.slice(marker[0].length);
    depth++;
  }
  return { content, depth };
}

/** Remove Markdown blockquote syntax while retaining indentation inside the quote. */
function stripBlockquotePrefix(line) {
  return blockquoteLineInfo(line).content;
}

function tableRowInfo(line, fenced) {
  if (fenced) return null;
  const content = stripBlockquotePrefix(line);
  const trimmed = content.trim();
  if (!splitTableCells(trimmed)) return null;
  return {
    indented: /^[ \t]+/.test(content),
    delimiter: normalizeTableDelimiter(trimmed) != null,
    text: trimmed,
  };
}

/**
 * Canonical form for comparing a description we sent against what Linear stored.
 * Absorbs Linear's known cosmetic rewrites; preserves every visible character, so
 * dropped or mangled content still shows up as a difference.
 */
export function normalizeForCompare(md) {
  let out = String(md ?? "");
  // (1) YAML frontmatter ↔ ```yaml fence — reduce both to a bare fence marker.
  out = out.replace(
    /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/,
    (_m, body) => "```yaml\n" + body + "\n```\n"
  );
  const marked = markFences(out);
  const tableRows = marked.map(({ line, fenced }) => tableRowInfo(line, fenced));
  const lines = [];
  for (let index = 0; index < marked.length; index++) {
    const { line, fenced } = marked[index];
    if (fenced) {
      lines.push(line);
      continue;
    }
    // (2) strip paired asterisk emphasis in prose, never stars in code/globs or underscores.
    let normalized = mapOutsideCodeSpans(line, normalizeEmphasis);
    // Linear canonicalises unordered-list markers to `*`.
    normalized = normalized.replace(/^(\s*(?:>\s*)*)[-*](?=[ \t]+)/, "$1*");
    // Only canonicalize a delimiter with an actual table header immediately above it.
    if (tableRows[index]?.delimiter && tableRows[index - 1]) {
      const row = tableRows[index].text;
      normalized = normalized.replace(row, normalizeTableDelimiter(row));
    }
    // Whitespace outside code is cosmetic; whitespace inside code is content.
    normalized = mapOutsideCodeSpans(normalized, (prose) => prose.replace(/[ \t]+/g, " ")).trim();
    if (normalized === "") continue;
    lines.push(normalized);
  }
  return lines.join("\n").trim();
}

/**
 * Locate markdown tables indented under a list item — the shape Linear corrupts.
 * Returns `[{ line, text }]`, 1-indexed, empty when clean. Rows inside code fences
 * are ignored: a fenced example of the bug is not the bug.
 */
export function findIndentedTables(md) {
  const rows = markFences(md).map(({ line, fenced }) => tableRowInfo(line, fenced));
  const hitLines = new Set();
  for (let delimiter = 1; delimiter < rows.length; delimiter++) {
    if (!rows[delimiter]?.delimiter || !rows[delimiter - 1]) continue;
    let end = delimiter + 1;
    while (end < rows.length && rows[end]) end++;
    for (let row = delimiter - 1; row < end; row++) {
      if (rows[row].indented) hitLines.add(row);
    }
  }
  return [...hitLines]
    .sort((a, b) => a - b)
    .map((line) => ({ line: line + 1, text: rows[line].text }));
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

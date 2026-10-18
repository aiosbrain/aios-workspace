/**
 * Resolve the work key(s) a PR implements, using a priority-based selection rule.
 * Canonical source — the inline copy in aios-work-sync.yml must be kept in sync.
 *
 * Priority (highest to lowest):
 *   1. Explicit `AIOS-Work:` trailers in the PR body — supports multiple keys.
 *   2. A work key leading the branch name, right after the `type/` prefix
 *      (case-insensitive; branches are lowercase: `feat/aio-539-…`). Hierarchical keys (W2.5.8)
 *      are never taken from a branch name.
 *      Version and package branches (`release/v0.11.1`, `remediation/aio1112-toolkit-2.1`)
 *      carry no key and fall through to the title.
 *   3. A key in the PR title.
 *   4. Body-only mentions → returns [] (no work event fired).
 *
 * @param {string} title   PR title
 * @param {string} body    PR body (HTML comments are stripped before scanning)
 * @param {string} headRef branch name (e.g. "feat/aio-539-mutation")
 * @param {string[]} [notes] receives human-readable notes (e.g. an unreadable trailer)
 * @returns {string[]} Deduplicated array of uppercase work-key strings, possibly empty.
 */

// Matches Linear identifiers (AIO-539) and hierarchical brain keys (W2.5.8).
// Used case-sensitively for title and body (convention: uppercase there).
const WORK_KEY_RE = /\b([A-Z][A-Z0-9]+-\d+|[A-Z]\d+(?:\.\d+)*)\b/g;

// Branch keys: anchored at the start of the branch or the segment after `type/`.
// Linear-shaped only (two or more letters + hyphen + digits, e.g. aio-539 → AIO-539).
// Hierarchical keys (W2.5.8) are NOT extracted from branch names; they fall through to
// the title. Version and package branches (`release/v0.11.1`, `brain-api-1.22-…`)
// carry no extractable key and fall through to title. Length-bounded to prevent
// backtracking on long slash-free branch names.
const BRANCH_KEY_RE = /^(?:[^/]{1,256}\/)?([A-Z]{2,30}-\d{1,8})(?![A-Z0-9.])/i;

const KEY_ONLY_RE = /^(?:[A-Z][A-Z0-9]+-\d+|[A-Z]\d+(?:\.\d+)*)$/;

// Unwrap Markdown wrappers so `AIO-5`, (AIO-5), [AIO-5](url), **AIO-5**, AIO-5. etc. are recognized.
// Link extraction is linear; char-strip is guarded by a length cap to prevent quadratic backtracking.
const unwrap = (tok) => {
  tok = tok.replace(/^\[([^\]]+)\]\([^)]*\)/, "$1");
  if (tok.length > 200) return tok;
  return tok.replace(/^[[(`*_"']+/, "").replace(/[\])`*_.,;:"']+$/, "");
};

/**
 * Extract the leading run of work keys from an `AIOS-Work:` trailer value. Keys are separated by
 * spaces, commas or semicolons; the first token that is not a key stops the run, so
 * `AIO-568 (epic AIO-541)` yields only AIO-568. Returns [] for an unreadable line.
 */
function extractLeadingKeyRun(trailerValue) {
  const keys = [];
  for (const raw of trailerValue.split(/[\s,;]+/)) {
    if (!raw) continue;
    const tok = unwrap(raw).toUpperCase();
    if (tok.length > 64 || !KEY_ONLY_RE.test(tok)) break;
    keys.push(tok);
  }
  return keys;
}

export function resolveWorkKeys(title, body, headRef, notes = []) {
  title = String(title ?? "");
  headRef = String(headRef ?? "");
  const cleanBody = String(body ?? "").replace(/<!--[\s\S]*?-->/g, " ");

  // 1. Explicit trailers — global iteration over ALL "AIOS-Work:" lines.
  //    Only the leading key run counts; the first non-key token stops the run.
  //    Keys may be wrapped in Markdown (backticks, parens, bold, markdown links, punctuation).
  //    Line-anchored (^…gm) so an empty trailer line cannot swallow the next line.
  const trailerLineRe = /^[ \t]*AIOS-Work:[ \t]*([^\r\n]+)/gm;
  const trailerKeys = [];
  let sawTrailer = false;
  for (const line of cleanBody.matchAll(trailerLineRe)) {
    sawTrailer = true;
    const run = extractLeadingKeyRun(line[1]);
    trailerKeys.push(...run);
  }
  if (trailerKeys.length > 0) return [...new Set(trailerKeys)];
  if (sawTrailer)
    notes.push(
      "an AIOS-Work trailer is present but no key could be read from it; falling back to branch and title"
    );

  // 2. Branch name — first (leading) Linear-shaped key only; a branch encodes one issue.
  //    Hierarchical keys (W2.5.8) are not extracted from branch names.
  const bm = headRef.match(BRANCH_KEY_RE);
  if (bm) return [bm[1].toUpperCase()];

  // 3. PR title — the first Linear-shaped key; a hierarchical key (W2.5.8) only if it has a dot and
  //    no Linear key exists, so a dotless token like Q3 or V2 can never shadow the real key.
  const titleKeys = title.match(WORK_KEY_RE) ?? [];
  const pick = titleKeys.find((k) => /-\d+$/.test(k)) ?? titleKeys.find((k) => k.includes("."));
  if (pick) return [pick];

  // 4. Body-only mentions → no work event.
  return [];
}

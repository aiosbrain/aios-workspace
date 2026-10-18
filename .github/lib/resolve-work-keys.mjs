/**
 * Resolve the work key(s) a PR implements, using a priority-based selection rule.
 * Canonical source — the inline copy in aios-work-sync.yml must be kept in sync.
 *
 * Priority (highest to lowest):
 *   1. Explicit `AIOS-Work:` trailers in the PR body — supports multiple keys.
 *   2. A Linear key leading the branch name, right after the `type/` prefix
 *      (case-insensitive; branches are lowercase: `feat/aio-539-…`). Version and package
 *      branches (`release/v0.11.1`, `remediation/aio1112-toolkit-2.1`) carry no key and
 *      fall through to the title.
 *   3. A key in the PR title.
 *   4. Body-only mentions → returns [] (no work event fired).
 *
 * @param {string} title   PR title
 * @param {string} body    PR body (HTML comments are stripped before scanning)
 * @param {string} headRef branch name (e.g. "feat/aio-539-mutation")
 * @returns {string[]} Deduplicated array of uppercase work-key strings, possibly empty.
 */

// Matches Linear identifiers (AIO-539) and hierarchical brain keys (W2.5.8).
// Used case-sensitively for title and body (convention: uppercase there).
const WORK_KEY_RE = /\b([A-Z][A-Z0-9]+-\d+|[A-Z]\d+(?:\.\d+)*)\b/g;

// Branch keys: Linear-shaped only (two+ letters, hyphen, digits), anchored at the start of the
// branch or of the segment after `type/`. Unanchored matching manufactured `V0.11.1` from
// `release/v0.11.1` and `API-1` from `brain-api-1.22-…`, outranking the real key in the title.
const BRANCH_KEY_RE = /^(?:[^/]+\/)?([A-Z]{2,}[A-Z0-9]*-\d+)(?![A-Z0-9])/i;

export function resolveWorkKeys(title, body, headRef) {
  title = String(title ?? "");
  headRef = String(headRef ?? "");
  const cleanBody = String(body ?? "").replace(/<!--[\s\S]*?-->/g, " ");

  // 1. Explicit trailers — global iteration over ALL "AIOS-Work:" lines.
  //    Each line may list multiple keys: "AIOS-Work: AIO-531 AIO-532".
  //    Line-anchored (^…gm) so an empty trailer line cannot swallow the next
  //    line and treat a body mention as an explicit key.
  const trailerLineRe = /^[ \t]*AIOS-Work:[ \t]*([^\r\n]+)/gm;
  const trailerKeys = [];
  for (const line of cleanBody.matchAll(trailerLineRe)) {
    for (const km of line[1].matchAll(WORK_KEY_RE)) {
      trailerKeys.push(km[1]);
    }
  }
  if (trailerKeys.length > 0) return [...new Set(trailerKeys)];

  // 2. Branch name — first (leading) key only; a branch encodes one issue.
  const bm = headRef.match(BRANCH_KEY_RE);
  if (bm) return [bm[1].toUpperCase()];

  // 3. PR title — first match only.
  if (title) {
    const m = title.match(WORK_KEY_RE);
    if (m) return [m[0]];
  }

  // 4. Body-only mentions → no work event.
  return [];
}

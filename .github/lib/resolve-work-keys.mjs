/**
 * Resolve the work key(s) a PR implements, using a priority-based selection rule.
 * Canonical source — the inline copy in aios-work-sync.yml must be kept in sync.
 *
 * Priority (highest to lowest):
 *   1. Explicit `AIOS-Work:` trailers in the PR body — supports multiple keys.
 *   2. A key embedded in the branch name (case-insensitive; branches are lowercase).
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

export function resolveWorkKeys(title, body, headRef) {
  const cleanBody = (body || "").replace(/<!--[\s\S]*?-->/g, " ");

  // 1. Explicit trailers — global iteration over ALL "AIOS-Work:" lines.
  //    Each line may list multiple keys: "AIOS-Work: AIO-531 AIO-532".
  const trailerLineRe = /\bAIOS-Work:\s*(.+)/g;
  const trailerKeys = [];
  for (const line of cleanBody.matchAll(trailerLineRe)) {
    for (const km of line[1].matchAll(WORK_KEY_RE)) {
      trailerKeys.push(km[1]);
    }
  }
  if (trailerKeys.length > 0) return [...new Set(trailerKeys)];

  // 2. Branch name — case-INSENSITIVE (branches are lowercase by convention).
  //    Returns the first match only (a branch encodes one issue).
  if (headRef) {
    const branchRe = /\b([A-Z][A-Z0-9]+-\d+|[A-Z]\d+(?:\.\d+)*)\b/i;
    const m = headRef.match(branchRe);
    if (m) return [m[1].toUpperCase()];
  }

  // 3. PR title — first match only.
  if (title) {
    const m = title.match(WORK_KEY_RE);
    if (m) return [m[0]];
  }

  // 4. Body-only mentions → no work event.
  return [];
}

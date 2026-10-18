/**
 * Resolve the work key(s) a PR implements, using a priority-based selection rule.
 * Canonical source — the inline copy in aios-work-sync.yml must be kept in sync.
 *
 * Priority (highest to lowest):
 *   1. Explicit `AIOS-Work:` trailers in the PR body — supports multiple keys.
 *   2. A work key leading the branch name, right after the `type/` prefix
 *      (case-insensitive; branches are lowercase: `feat/aio-539-…`, `feat/w2.5.8-support`).
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
// Two alternations, both case-insensitive (branches are lowercase by convention):
//   1. Linear-shaped: letter + letters/digits + hyphen + digits (e.g. aio-539 → AIO-539).
//   2. Hierarchical brain key: letter A-U or W-Z (not V to avoid semver `v0.11.1`) + digits +
//      one or more dot-segments (e.g. w2.5.8 → W2.5.8). Requires ≥1 dot to avoid bare `W2`.
// Unanchored matching manufactured `V0.11.1` from `release/v0.11.1` and `API-1` from
// `brain-api-1.22-…`, outranking the real key in the title.
const BRANCH_KEY_RE = /^(?:[^/]{1,256}\/)?([A-Z][A-Z0-9]+-\d+|[A-UW-Z]\d+(?:\.\d+)+)(?![A-Z0-9])/i;

export function resolveWorkKeys(title, body, headRef, notes = []) {
  title = String(title ?? "");
  headRef = String(headRef ?? "");
  const cleanBody = String(body ?? "").replace(/<!--[\s\S]*?-->/g, " ");

  // 1. Explicit trailers — global iteration over ALL "AIOS-Work:" lines.
  //    Each line may list multiple keys: "AIOS-Work: AIO-531 AIO-532".
  //    Line-anchored (^…gm) so an empty trailer line cannot swallow the next
  //    line and treat a body mention as an explicit key.
  //    Full-line scan with WORK_KEY_RE: every key on the line is extracted, including
  //    keys after prose connectors ("AIO-1, AIO-2 and AIO-3" → all three).
  const trailerLineRe = /^[ \t]*AIOS-Work:[ \t]*([^\r\n]+)/gm;
  const trailerKeys = [];
  let sawTrailer = false;
  for (const line of cleanBody.matchAll(trailerLineRe)) {
    sawTrailer = true;
    for (const km of line[1].matchAll(WORK_KEY_RE)) {
      trailerKeys.push(km[1]);
    }
  }
  if (trailerKeys.length > 0) return [...new Set(trailerKeys)];
  if (sawTrailer)
    notes.push(
      "an AIOS-Work trailer is present but no key could be read from it; falling back to branch and title"
    );

  // 2. Branch name — first (leading) key only; a branch encodes one issue.
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

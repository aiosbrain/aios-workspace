// C5 deterministic text-leak sweep — closes the gap C3 does NOT cover.
//
// C3's verifier validates that each claim's evidence REFS resolve to real manifest signals and
// that no above-audience ref/path/row leaks into a digest projection. It does NOT semantically
// check that a claim's free TEXT is supported by its cited ref. So a drafter could cite a
// legitimately allowed (lower-tier) ref while writing claim TEXT that quotes/paraphrases an
// above-audience signal's summary, path, or row — and C3 alone would pass it.
//
// This sweep is the deterministic backstop: before any shareable text is emitted, check it for
// exact occurrences of the above-audience signal strings (`aboveAudienceStrings` from project.ts).
// Pure string containment — NO LLM, never part of an LLM judgment. A hit means withhold/abort,
// never "trust the model". Used per-claim during render (withhold the offending claim) and again
// as a whole-document + `--json` belt-and-suspenders check before any write/stdout.

/**
 * Return the above-audience strings that appear (case-insensitive exact substring) in `text`.
 * Empty array → the text is clean. The check is conservative: a false positive withholds a claim
 * (fail-safe), which is the correct bias for a tier-safety backstop.
 */
export function sweepForLeaks(text: string, aboveStrings: Iterable<string>): string[] {
  if (!text) return [];
  const haystack = text.toLowerCase();
  const hits: string[] = [];
  for (const raw of aboveStrings) {
    const needle = (raw ?? "").trim();
    if (needle.length === 0) continue;
    if (haystack.includes(needle.toLowerCase())) hits.push(raw);
  }
  return hits;
}

/** Convenience boolean wrapper for guards. */
export function hasLeak(text: string, aboveStrings: Iterable<string>): boolean {
  return sweepForLeaks(text, aboveStrings).length > 0;
}

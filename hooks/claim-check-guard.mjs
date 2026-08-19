#!/usr/bin/env node
/**
 * Claim-check guard — a Stop hook that warns when the assistant asserts something works without
 * visible evidence of having measured it.
 *
 * WHY THIS EXISTS. On 2026-08-19 one session made five separate false "it works" claims in a day,
 * every one of them by measuring a proxy instead of the property the change existed to produce:
 * an item count instead of the task rows a feature reads, an entity table whose prior value was
 * never recorded, a ratio whose denominator had just been deleted, and the absence of errors in a
 * table that had just been routed around. The rule is in CLAUDE.md and the procedure is the
 * `check-claim` skill; this hook is the part that fires whether or not anyone remembered them.
 *
 * WHAT IT CAN AND CANNOT DO. It cannot tell whether the right thing was measured — that is a
 * judgement about intent. It can tell, cheaply and deterministically, that a CLAIM was made and
 * that the message shows no sign of a MEASUREMENT. That combination is worth one line of friction.
 *
 * DESIGN CONSTRAINTS, learned from the guards that failed this codebase:
 *   - NEVER blocks. A gate that interrupts on judgement gets disabled, and a disabled gate is worse
 *     than none — the same way a `verify-desc` that failed on every write stopped being a gate.
 *   - Only fires when claim language is present AND evidence markers are absent, so a report that
 *     already quotes numbers stays silent. Noise is the failure mode that kills this hook.
 *   - ALWAYS exits 0, everything wrapped. A missed warning is acceptable; disturbing a session is
 *     not. (Same hard rule as hooks/asks-capture.mjs.)
 */

import { readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";

const TAIL_BYTES = 128 * 1024;

/** Assertions that something previously broken is now good. Deliberately narrow: these are claims,
 *  not descriptions. "I'm fixing" is not here.
 *
 *  NOTE ON SHAPE: the words "verified", "confirmed" and "resolved" are NOT matched bare. Measured
 *  over 150 turn-final assistant messages from real transcripts, bare forms fired on 8.7% of them —
 *  and almost none were claims: "I have not verified this yet", "confirmed with John that…", "the
 *  import path resolved to…", "the promise resolved before the timeout", "once you've confirmed the
 *  credentials". They are only claims in predicate position ("is resolved", "now confirmed"), so
 *  that is all we match. Same anchoring reason keeps this list free of bare "done" and "fixed". */
const CLAIM_PATTERNS = [
  /\bit (?:now )?works\b/i,
  /\bnow works\b/i,
  /\bworking now\b/i,
  /\bworks (?:now|as expected|correctly)\b/i,
  /\b(?:is|are|it'?s|that'?s|now|fully)\s+(?:verified|confirmed|resolved|fixed|working)\b/i,
  /\bfully (?:working|extracted|fixed)\b/i,
  /\ball green\b/i,
  /\ball set\b/i,
  /\bgood to go\b/i,
  /\bshould be good\b/i,
  /\bthe fix is in\b/i,
  /\bthat did it\b/i,
  /\bproved? out\b/i,
  /\bis live and working\b/i,
  /\bsucceeded\b/i,
  /\btests (?:now )?pass(?:ing)?\b/i,
];

/** The earliest claim in the text, or null. One pattern per idiom rather than one long
 *  alternation: the alternation was unreadable and tripped the repo's complexity gate. */
function firstClaim(text) {
  let earliest = null;
  for (const pattern of CLAIM_PATTERNS) {
    const match = pattern.exec(text);
    if (match && (earliest === null || match.index < earliest.index)) earliest = match;
  }
  return earliest;
}

/** Hedges and conditionals. A claim word inside the SAME clause as one of these is not an assertion —
 *  it is a denial ("not verified"), a condition ("if it is resolved"), or a request ("once you've
 *  confirmed"). Checked against the text between the previous clause break and the match.
 *  Kept as a word list, not a hand-written alternation, so it stays legible as it grows. */
const HEDGE_WORDS = [
  "not",
  "never",
  "isn'?t",
  "aren'?t",
  "wasn'?t",
  "weren'?t",
  "hasn'?t",
  "haven'?t",
  "hadn'?t",
  "don'?t",
  "doesn'?t",
  "didn'?t",
  "can'?t",
  "cannot",
  "couldn'?t",
  "won'?t",
  "unable",
  "unclear",
  "if",
  "whether",
  "once",
  "when",
  "unless",
  "until",
  "assuming",
  "hope",
  "hoping",
  "need",
  "needs",
  "needed",
  "would",
  "might",
];
const HEDGE_RE = new RegExp(`\\b(?:${HEDGE_WORDS.join("|")})\\b`, "i");

const CLAUSE_BREAKS = [".", "\n", "!", "?", ";", ",", ":"];

function hedged(text, idx) {
  let start = -1;
  for (const ch of CLAUSE_BREAKS) start = Math.max(start, text.lastIndexOf(ch, idx - 1));
  return HEDGE_RE.test(text.slice(start + 1, idx));
}

/** Signs a measurement actually happened — a number, a table, a command, a quoted result. If any of
 *  these are present the message is showing its work, and the reminder would be noise. */
const EVIDENCE_RE = [
  /\d+\s*\/\s*\d+/, // 9/56 style progress
  /\bHTTP\s*\d{3}\b/i, // status codes
  /```/, // a quoted command or output block
  /\|\s*-{2,}/, // a markdown table separator
  /\b(?:before|baseline)\b[^.]{0,40}\b(?:after|now)\b/i, // an explicit before/after
  /\bcount\s*[=:]\s*\d+/i,
  /\b\d+\s+(?:tests?|rows?|items?|episodes?|records?|facts?|passed)\b/i,
];

function tail(file) {
  const size = statSync(file).size;
  const start = Math.max(0, size - TAIL_BYTES);
  const len = size - start;
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, start);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** The assistant's last message text, from the transcript's trailing lines. */
function lastAssistantText(transcriptPath) {
  const lines = tail(transcriptPath).split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue; // a truncated first line from the tail read
    }
    if (entry?.type !== "assistant") continue;
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

function main() {
  let payload = {};
  try {
    payload = JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {
    return;
  }
  const transcript = payload?.transcript_path;
  if (!transcript) return;

  let text = "";
  try {
    text = lastAssistantText(transcript);
  } catch {
    return;
  }
  if (!text) return;

  const claims = firstClaim(text);
  if (!claims) return;
  if (hedged(text, claims.index)) return; // negated, conditional, or asking — not an assertion
  if (EVIDENCE_RE.some((re) => re.test(text))) return; // it showed its work

  const systemMessage =
    `⚠  claim-check: you asserted "${claims[0]}" without a visible measurement in that message.\n` +
    `   Ask the one question that catches this: if the change had SILENTLY failed, would what you ` +
    `measured look any different?\n` +
    `   Absence of errors is not success. A ratio is not progress. A number you did not record ` +
    `beforehand is not a baseline.\n` +
    `   → Run the \`check-claim\` skill, or state plainly what you measured and what you did not.`;

  process.stdout.write(JSON.stringify({ systemMessage }));
}

try {
  main();
} catch {
  // never disturb a session
}
process.exit(0);

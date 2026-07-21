#!/usr/bin/env node
// test/consolidate-findings.test.mjs — the findings consolidator with INJECTED runGh/callAgent
// (no live gh/claude, no network). Covers: gather argv exactness, CLEAR/BLOCKED verdicts +
// return codes, fail-closed max-severity inheritance, CI-red-as-data, output path, the
// config-driven model call, and the severity extractors. Run: node test/consolidate-findings.test.mjs

import {
  cmdConsolidateFindings,
  gatherInputs,
  buildConsolidatePrompt,
  parseCheckResults,
  preExtractSeverities,
  postValidate,
  computeVerdict,
  defaultOutPath,
  extractLocalBugbotSeverities,
  extractGptSeverities,
  extractCodeRabbitSeverities,
  stripFrontmatter,
  GPT_REVIEW_CAP,
  filterCurrentHeadCodeRabbit,
} from "../scripts/consolidate-findings.mjs";
import { DIFF_CAP } from "../scripts/build.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(DIR, "fixtures", "consolidate");
const readFix = (f) => readFileSync(path.join(FIX, f), "utf8");
const LOCAL_BUGBOT_CLEAR = path.join(FIX, "local-bugbot-clear.md");
const LOCAL_BUGBOT_HIGH = path.join(FIX, "local-bugbot-high.md");
const latestCommit = () => JSON.stringify({ sha: "head123", committed_at: "2026-07-01T00:00:00Z" });
const consolidateArgs = (
  pr = "44",
  slug = "acme/repo",
  extra = [],
  localBugbotReviewPath = LOCAL_BUGBOT_CLEAR
) => [
  "--pr",
  pr,
  "--issue",
  "AIO-161",
  "--repo",
  slug,
  "--local-bugbot-review",
  localBugbotReviewPath,
  ...extra,
];

let failed = 0;
const RED = "\x1b[0;31m",
  GREEN = "\x1b[0;32m",
  NC = "\x1b[0m";
function check(label, cond) {
  if (cond) console.log(`  ${GREEN}✓${NC} ${label}`);
  else {
    console.log(`  ${RED}✗${NC} ${label}`);
    failed++;
  }
}

const REVIEWER =
  "You are the AIOS Workspace Code Reviewer.\n## Output format\n[severity] file:line — desc";
const cleanups = [];
function freshRepo() {
  const repo = mkdtempSync(path.join(tmpdir(), "consol-repo-"));
  cleanups.push(repo);
  return repo;
}

// A fake runGh keyed on argv. `responses` supplies each endpoint's payload; `calls` records
// the exact argv arrays so we can assert no shell was used.
function makeRunGh(responses, calls) {
  return (argv) => {
    calls.push(argv);
    if (argv[0] === "pr" && argv[1] === "checks") return responses.checks; // {code,stdout,stderr}
    if (argv[0] === "pr" && argv[1] === "diff") return responses.prDiff ?? "";
    if (argv[0] === "api" && argv[1].endsWith("/commits"))
      return responses.latestCommit ?? latestCommit();
    if (argv[0] === "api" && argv[1].includes("/issues/")) return responses.issueComments ?? "[]";
    if (argv[0] === "api" && argv[1].endsWith("/comments")) return responses.inlineComments ?? "[]";
    if (argv[0] === "api" && argv[1].endsWith("/reviews")) return responses.reviews ?? "[]";
    return "";
  };
}
const passChecks = () => ({ code: 0, stdout: readFix("pr-checks-pass.json"), stderr: "" });
const failChecks = () => ({
  code: 1,
  stdout: readFix("pr-checks-fail.json"),
  stderr: "checks failed",
});
// `gh pr checks` exits non-zero while a check is still running; stdout carries the board.
const pendingChecks = () => ({
  code: 8,
  stdout: readFix("pr-checks-pending.json"),
  stderr: "",
});

// Silence the command's own console output during a run.
async function quiet(fn) {
  const log = console.log,
    err = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    console.error = err;
  }
}

// ── pure: stripFrontmatter ─────────────────────────────────────────────────────
console.log("stripFrontmatter");
{
  check(
    "removes a leading YAML block",
    stripFrontmatter("---\nname: x\n---\nbody here").startsWith("body here")
  );
  check("no-op without frontmatter", stripFrontmatter("body only") === "body only");
}

// ── pure: parseCheckResults ─────────────────────────────────────────────────────
console.log("parseCheckResults");
{
  const pass = parseCheckResults(readFix("pr-checks-pass.json"));
  check("clean board → ciRed false", pass.ciRed === false && pass.checks.length === 2);
  const fail = parseCheckResults(readFix("pr-checks-fail.json"));
  check("failed board → ciRed true", fail.ciRed === true);
  check(
    "plaintext fallback detects failure",
    parseCheckResults("build   fail   1s").ciRed === true
  );
  check("empty → not red", parseCheckResults("").ciRed === false);
  const pend = parseCheckResults(readFix("pr-checks-pending.json"));
  check(
    "pending board → ciPending true, ciRed false",
    pend.ciPending === true && pend.ciRed === false
  );
  check("clean board → ciPending false", pass.ciPending === false);
  check(
    "plaintext fallback detects pending",
    parseCheckResults("build   pending   -").ciPending === true
  );
  check("valid JSON array → parsed true", pass.parsed === true);
  check("plaintext board → parsed true", parseCheckResults("build fail 1s").parsed === true);
  check("empty stdout → parsed false", parseCheckResults("").parsed === false);
  // Real gh shape carries `bucket`, not `conclusion`: bucket drives red/pending.
  check("bucket=fail → ciRed true", fail.checks.some((x) => x.bucket === "fail") && fail.ciRed);
  check(
    "bucket=cancel → ciRed true",
    parseCheckResults('[{"name":"x","state":"CANCELLED","bucket":"cancel"}]').ciRed === true
  );
  check(
    "bucket=skipping → benign (not red, not pending)",
    (() => {
      const r = parseCheckResults('[{"name":"x","state":"NEUTRAL","bucket":"skipping"}]');
      return r.ciRed === false && r.ciPending === false && r.parsed === true;
    })()
  );
  // M2: gh error PROSE is not a checks table → parsed false, never a spurious red board.
  {
    const prose = parseCheckResults("authentication failed for host github.com");
    check("error prose → parsed false (not a table)", prose.parsed === false);
    check("error prose → ciRed false (no spurious red)", prose.ciRed === false);
  }
  check(
    "multi-line error prose → parsed false",
    parseCheckResults("gh: request failed\nplease re-authenticate").parsed === false
  );
}

// ── pure: severity extractors ──────────────────────────────────────────────────
console.log("severity extractors");
{
  check(
    "Local Bugbot structured High → High",
    extractLocalBugbotSeverities(readFix("local-bugbot-high.md")) === "High"
  );
  check(
    "clear Local Bugbot → null",
    extractLocalBugbotSeverities(readFix("local-bugbot-clear.md")) === null
  );
  check("GPT `High` bullet → High", extractGptSeverities(readFix("gpt-review.md")) === "High");
  check(
    "CodeRabbit Major/potential issue → High",
    extractCodeRabbitSeverities(JSON.parse(readFix("coderabbit-comments.json"))) === "High"
  );
  const pre = preExtractSeverities({
    checks: parseCheckResults(readFix("pr-checks-pass.json")),
    localBugbot: readFix("local-bugbot-high.md"),
    coderabbit: JSON.parse(readFix("coderabbit-comments.json")),
    gpt: readFix("gpt-review.md"),
  });
  check("preExtract sourceMax = Critical/High", pre.sourceMax === "High" && pre.ciRed === false);
}

// ── pure: postValidate + computeVerdict (fail-closed) ───────────────────────────
console.log("postValidate + computeVerdict");
{
  // CI red forces BLOCKED even on a CLEAR model doc, and the forced state is unloseable.
  const red = postValidate({
    modelOutput: readFix("agent-clear.md"),
    sourceMax: null,
    ciRed: true,
    checks: parseCheckResults(readFix("pr-checks-fail.json")),
  });
  check("CI red forces block", red.forcedBlock === true);
  check("forced block verdict is BLOCKED after FINAL compute", computeVerdict(red) === "BLOCKED");
  check("forced block strips BUGBOT_CLEAR", !/BUGBOT_CLEAR/.test(red.text));
  check("forced block names the red job", /build/.test(red.text) && /\[High\]/.test(red.text));

  // CI pending forces BLOCKED even on a CLEAR model doc (fail closed — board unsettled).
  const pending = postValidate({
    modelOutput: readFix("agent-clear.md"),
    sourceMax: null,
    ciRed: false,
    ciPending: true,
    checks: parseCheckResults(readFix("pr-checks-pending.json")),
  });
  check("CI pending forces block", pending.forcedBlock === true);
  check("pending forced verdict is BLOCKED", computeVerdict(pending) === "BLOCKED");
  check(
    "pending block names the pending job",
    /build/.test(pending.text) && /pending/i.test(pending.text)
  );

  // Dropped source High: sources say High, model says CLEAR → forced block.
  const dropped = postValidate({
    modelOutput: readFix("agent-clear.md"),
    sourceMax: "High",
    ciRed: false,
  });
  check(
    "dropped source High forces block",
    dropped.forcedBlock === true && computeVerdict(dropped) === "BLOCKED"
  );

  // Genuinely clean: no source severity, CI green, CLEAR doc → stays CLEAR.
  const clean = postValidate({
    modelOutput: readFix("agent-clear.md"),
    sourceMax: null,
    ciRed: false,
  });
  check("clean stays CLEAR", clean.forcedBlock === false && computeVerdict(clean) === "CLEAR");

  // A model [High] doc is BLOCKED via the bracket matcher.
  const blocked = postValidate({
    modelOutput: readFix("agent-blocked.md"),
    sourceMax: "High",
    ciRed: false,
  });
  check("model [High] doc → BLOCKED", computeVerdict(blocked) === "BLOCKED");
}

// ── pure: defaultOutPath ────────────────────────────────────────────────────────
console.log("defaultOutPath");
{
  check(
    "path is .aios/loop/<issue>/findings-r<N>.md",
    defaultOutPath("/repo", "AIO-161", 2).endsWith(
      path.join(".aios", "loop", "AIO-161", "findings-r2.md")
    )
  );
}

// ── gather: exact argv + prompt assembly (Major 1: PR diff present) ─────────────
console.log("gatherInputs — exact argv, no shell; PR diff in the prompt");
{
  const calls = [];
  const runGh = makeRunGh(
    {
      checks: passChecks(),
      prDiff: readFix("pr-diff.txt"),
      issueComments: "[]",
      inlineComments: readFix("coderabbit-comments.json"),
      reviews: "[]",
    },
    calls
  );
  const inputs = gatherInputs({
    runGh,
    slug: "acme/repo",
    pr: "44",
    localBugbotReviewPath: LOCAL_BUGBOT_CLEAR,
  });
  check(
    "checks argv exact",
    JSON.stringify(calls[0]) ===
      JSON.stringify(["pr", "checks", "44", "--repo", "acme/repo", "--json", "name,state,bucket"])
  );
  // H2 pin: the code MUST request exactly `name,state,bucket`. `conclusion` is NOT a valid
  // `gh pr checks --json` field — requesting it makes real gh exit 1 ("Unknown JSON field"),
  // so the board would always come back unavailable. This assertion fails the SUITE (not
  // production) if the field list ever regresses to include an invalid field.
  {
    const jsonIdx = calls[0].indexOf("--json");
    const fields = (calls[0][jsonIdx + 1] ?? "").split(",");
    check(
      "checks --json field list is exactly name,state,bucket",
      jsonIdx >= 0 && JSON.stringify(fields) === JSON.stringify(["name", "state", "bucket"])
    );
    check(
      "checks --json does NOT request the invalid 'conclusion' field",
      !fields.includes("conclusion")
    );
  }
  check(
    "latest-commit argv exact",
    calls[1][0] === "api" && calls[1][1] === "repos/acme/repo/pulls/44/commits"
  );
  check(
    "diff argv exact",
    JSON.stringify(calls[2]) === JSON.stringify(["pr", "diff", "44", "--repo", "acme/repo"])
  );
  check(
    "issue-comments api argv",
    calls[3][0] === "api" &&
      calls[3][1] === "repos/acme/repo/issues/44/comments" &&
      calls[3][2] === "--jq"
  );
  check("inline-comments api argv", calls[4][1] === "repos/acme/repo/pulls/44/comments");
  check("reviews api argv", calls[5][1] === "repos/acme/repo/pulls/44/reviews");
  check("no Cursor query remains", !calls.flat().some((value) => /cursor/i.test(String(value))));
  check("PR diff captured", inputs.prDiff.includes("while (true)"));
  check("Local Bugbot artifact captured", inputs.localBugbotMarkdown.includes("BUGBOT_CLEAR"));

  const prompt = buildConsolidatePrompt(REVIEWER, { ...inputs, issue: "AIO-161" });
  check("prompt includes the reviewer body", prompt.includes("AIOS Workspace Code Reviewer"));
  check("prompt includes the PR diff (Major 1)", prompt.includes("while (true)"));
  check(
    "prompt asks for source tags",
    prompt.includes("(source: Local Bugbot|CodeRabbit|GPT-5.5)")
  );
}

// ── PR diff is capped at DIFF_CAP with a marker ─────────────────────────────────
console.log("gatherInputs — PR diff capped at DIFF_CAP");
{
  const big = "x".repeat(DIFF_CAP + 5000);
  const inputs = gatherInputs({
    runGh: makeRunGh({ checks: passChecks(), prDiff: big }, []),
    slug: "a/b",
    pr: "1",
    localBugbotReviewPath: LOCAL_BUGBOT_CLEAR,
  });
  check(
    "diff clipped to cap + marker",
    inputs.prDiff.length <= DIFF_CAP + 60 && inputs.prDiff.includes(`truncated at ${DIFF_CAP}`)
  );
}

// ── CLEAR path → returns 0, file ends BUGBOT_CLEAR ──────────────────────────────
console.log("CLEAR path");
{
  const repo = freshRepo();
  const calls = [];
  const runGh = makeRunGh(
    {
      checks: passChecks(),
      prDiff: "diff",
      inlineComments: "[]",
      issueComments: "[]",
      reviews: "[]",
    },
    calls
  );
  const code = await quiet(() =>
    cmdConsolidateFindings(repo, consolidateArgs(), {
      runGh,
      readReviewerPrompt: () => REVIEWER,
      callAgent: async () => readFix("agent-clear.md"),
    })
  );
  const out = readFileSync(defaultOutPath(repo, "AIO-161", 1), "utf8");
  check("returns 0 (CLEAR)", code === 0);
  check("file ends with BUGBOT_CLEAR", out.trim().endsWith("BUGBOT_CLEAR"));
}

// ── BLOCKED path ([High]) → returns 3 ───────────────────────────────────────────
console.log("BLOCKED path");
{
  const repo = freshRepo();
  const code = await quiet(() =>
    cmdConsolidateFindings(repo, consolidateArgs(), {
      runGh: makeRunGh({ checks: passChecks(), inlineComments: "[]" }, []),
      readReviewerPrompt: () => REVIEWER,
      callAgent: async () => readFix("agent-blocked.md"),
    })
  );
  const out = readFileSync(defaultOutPath(repo, "AIO-161", 1), "utf8");
  check("returns 3 (BLOCKED)", code === 3);
  check("no BUGBOT_CLEAR in a blocked file", !out.includes("BUGBOT_CLEAR"));
}

// ── fail-closed max-severity inheritance → returns 3 ────────────────────────────
console.log("fail-closed max-severity inheritance");
{
  const repo = freshRepo();
  const code = await quiet(() =>
    cmdConsolidateFindings(repo, consolidateArgs("44", "acme/repo", [], LOCAL_BUGBOT_HIGH), {
      // Local Bugbot has a structured High, but the model returns a CLEAR doc.
      runGh: makeRunGh({ checks: passChecks(), inlineComments: "[]" }, []),
      readReviewerPrompt: () => REVIEWER,
      callAgent: async () => readFix("agent-clear.md"),
    })
  );
  const out = readFileSync(defaultOutPath(repo, "AIO-161", 1), "utf8");
  check("returns 3 (forced block)", code === 3);
  check("verdict rewritten to BLOCKED", /##\s*Verdict[\s\S]*BLOCKED/.test(out));
  check("note names the dropped High", /AIOS Rule Violations/.test(out) && /High/.test(out));
}

// ── CI-red as data (Major 2) → returns 3, file still written ────────────────────
console.log("CI-red as data (Major 2)");
{
  const repo = freshRepo();
  const code = await quiet(() =>
    cmdConsolidateFindings(repo, consolidateArgs(), {
      // pr checks returns a NON-zero object (red board); model says CLEAR.
      runGh: makeRunGh({ checks: failChecks(), inlineComments: "[]" }, []),
      readReviewerPrompt: () => REVIEWER,
      callAgent: async () => readFix("agent-clear.md"),
    })
  );
  check("red CI returns 3, not 1", code === 3);
  check("findings file still written", existsSync(defaultOutPath(repo, "AIO-161", 1)));
}

// ── pending CI fails closed (reviewer blocker) → returns 3, file BLOCKED ─────────────
console.log("pending CI fails closed → 3");
{
  const repo = freshRepo();
  const code = await quiet(() =>
    cmdConsolidateFindings(repo, consolidateArgs(), {
      // gh pr checks returns a still-running board; model claims CLEAR. Must NOT pass through.
      runGh: makeRunGh({ checks: pendingChecks(), inlineComments: "[]" }, []),
      readReviewerPrompt: () => REVIEWER,
      callAgent: async () => readFix("agent-clear.md"),
    })
  );
  const out = readFileSync(defaultOutPath(repo, "AIO-161", 1), "utf8");
  check("pending CI returns 3 (not 0/CLEAR)", code === 3);
  check(
    "pending CI file verdict BLOCKED after FINAL compute",
    /##\s*Verdict\s*\n+\s*BLOCKED/.test(out)
  );
  check("pending CI file has no BUGBOT_CLEAR", !out.includes("BUGBOT_CLEAR"));
  check(
    "pending CI note names the pending job",
    /AIOS Rule Violations/.test(out) && /pending/i.test(out)
  );
}

// ── gh pr checks FAILS with no check data (auth/network) → fail closed, returns 1 ─────
console.log("CI evidence unavailable (gh failure) → 1");
{
  const repo = freshRepo();
  const code = await quiet(() =>
    cmdConsolidateFindings(repo, consolidateArgs(), {
      // gh pr checks exits non-zero with EMPTY stdout (auth/network/invalid repo); model CLEAR.
      runGh: makeRunGh(
        { checks: { code: 1, stdout: "", stderr: "auth failed" }, inlineComments: "[]" },
        []
      ),
      readReviewerPrompt: () => REVIEWER,
      callAgent: async () => readFix("agent-clear.md"),
    })
  );
  check("gh checks failure returns 1 (not 0/CLEAR)", code === 1);
  check(
    "no findings file written on unavailable CI",
    !existsSync(defaultOutPath(repo, "AIO-161", 1))
  );
}

// ── Current-head CodeRabbit review evidence remains fail-closed ─────────────────
console.log("current-head CodeRabbit High in a submitted review → 3");
{
  const repo = freshRepo();
  const code = await quiet(() =>
    cmdConsolidateFindings(repo, consolidateArgs(), {
      // No inline/issue comments; the only High lives in a fresh CodeRabbit review body.
      runGh: makeRunGh(
        {
          checks: passChecks(),
          inlineComments: "[]",
          issueComments: "[]",
          reviews: JSON.stringify([
            {
              user: "coderabbitai[bot]",
              state: "COMMENTED",
              body: "**Major** potential issue: unbounded retry loop can hang the process.",
              submitted_at: "2026-07-01T00:01:00Z",
            },
          ]),
        },
        []
      ),
      readReviewerPrompt: () => REVIEWER,
      callAgent: async () => readFix("agent-clear.md"),
    })
  );
  const out = readFileSync(defaultOutPath(repo, "AIO-161", 1), "utf8");
  check("fresh review-only High → returns 3 (not 0/CLEAR)", code === 3);
  check("fresh review-only High → file verdict BLOCKED", /##\s*Verdict\s*\n+\s*BLOCKED/.test(out));
  check("fresh review-only High → no BUGBOT_CLEAR", !out.includes("BUGBOT_CLEAR"));
}

// ── Stale CodeRabbit records cannot satisfy or contaminate current-head evidence ─────────
console.log("stale CodeRabbit issue comment is discarded");
{
  const repo = freshRepo();
  const code = await quiet(() =>
    cmdConsolidateFindings(repo, consolidateArgs(), {
      runGh: makeRunGh(
        {
          checks: passChecks(),
          inlineComments: "[]",
          issueComments: JSON.stringify([
            {
              user: "coderabbitai[bot]",
              body: "**Major** potential issue: missing null guard before dereference.",
              created_at: "2026-06-30T23:59:59Z",
            },
          ]),
          reviews: "[]",
        },
        []
      ),
      readReviewerPrompt: () => REVIEWER,
      callAgent: async () => readFix("agent-clear.md"),
    })
  );
  const out = readFileSync(defaultOutPath(repo, "AIO-161", 1), "utf8");
  check("stale issue comment does not block a clean current head", code === 0);
  check("stale issue comment is absent from consolidated output", !out.includes("null guard"));
}

console.log("filterCurrentHeadCodeRabbit");
{
  const records = [
    { user: "coderabbitai[bot]", body: "old", created_at: "2026-06-30T23:59:59Z" },
    { user: "coderabbitai[bot]", body: "fresh", created_at: "2026-07-01T00:00:00Z" },
    { user: "someone", body: "fresh human", created_at: "2026-07-01T00:01:00Z" },
  ];
  const filtered = filterCurrentHeadCodeRabbit(records, "2026-07-01T00:00:00Z");
  check("keeps only CodeRabbit records at or after the latest commit", filtered.length === 1);
  check("keeps the fresh record", filtered[0]?.body === "fresh");
}

// ── M2: gh error PROSE (contains "fail") is NOT a red board → fail closed, returns 1 ─────
console.log("M2: gh error prose → 1 (not a spurious red board)");
{
  const repo = freshRepo();
  const code = await quiet(() =>
    cmdConsolidateFindings(repo, consolidateArgs(), {
      // gh pr checks exits non-zero with an auth-error MESSAGE (not a checks table). The word
      // "failed" must NOT be read as red CI (exit 3) — no board data ⇒ unavailable ⇒ exit 1.
      runGh: makeRunGh(
        {
          checks: {
            code: 1,
            stdout: "authentication failed for host github.com",
            stderr: "gh: could not authenticate",
          },
          inlineComments: "[]",
        },
        []
      ),
      readReviewerPrompt: () => REVIEWER,
      callAgent: async () => readFix("agent-clear.md"),
    })
  );
  check("gh error prose returns 1 (not 3)", code === 1);
  check(
    "no findings file written on gh error prose",
    !existsSync(defaultOutPath(repo, "AIO-161", 1))
  );
}

// ── "no checks reported" (no CI configured) is benign → proceeds normally ─────────────
console.log("no checks reported (benign) → proceeds");
{
  const repo = freshRepo();
  const code = await quiet(() =>
    cmdConsolidateFindings(repo, consolidateArgs(), {
      // gh exits non-zero but the stderr says no CI is configured — treat as a green board.
      runGh: makeRunGh(
        {
          checks: { code: 1, stdout: "", stderr: "no checks reported on the 'feat/x' branch" },
          inlineComments: "[]",
        },
        []
      ),
      readReviewerPrompt: () => REVIEWER,
      callAgent: async () => readFix("agent-clear.md"),
    })
  );
  check("benign no-checks returns 0 (CLEAR)", code === 0);
  check("benign no-checks still writes findings", existsSync(defaultOutPath(repo, "AIO-161", 1)));
}

// ── written verdict can never contradict the computed verdict ───────────────────
console.log("verdict reconciliation (stale model verdict)");
{
  // Model lists a [High] finding but writes a stale CLEAR verdict → computed BLOCKED;
  // the persisted file MUST say BLOCKED, not the model's stale CLEAR.
  const repo = freshRepo();
  const staleClear =
    "## Findings\n\n[High] scripts/x.mjs:1 — boom (source: Local Bugbot)\n\n## Verdict\n\nCLEAR\n";
  const code = await quiet(() =>
    cmdConsolidateFindings(repo, consolidateArgs(), {
      runGh: makeRunGh({ checks: passChecks(), inlineComments: "[]" }, []),
      readReviewerPrompt: () => REVIEWER,
      callAgent: async () => staleClear,
    })
  );
  const out = readFileSync(defaultOutPath(repo, "AIO-161", 1), "utf8");
  check("[High]+stale CLEAR returns 3", code === 3);
  check("[High]+stale CLEAR file says BLOCKED", /##\s*Verdict\s*\n+\s*BLOCKED/.test(out));
  check(
    "[High]+stale CLEAR file has no stray CLEAR verdict",
    !/##\s*Verdict\s*\n+\s*CLEAR/.test(out)
  );
  check("[High]+stale CLEAR file has no BUGBOT_CLEAR", !out.includes("BUGBOT_CLEAR"));
}
{
  // Clean sources + clean findings but the model wrote a stale BLOCKED verdict →
  // computed CLEAR; the persisted file MUST say CLEAR and end with BUGBOT_CLEAR.
  const repo = freshRepo();
  const staleBlocked = "## Findings\n\n- No blocking issues found.\n\n## Verdict\n\nBLOCKED\n";
  const code = await quiet(() =>
    cmdConsolidateFindings(repo, consolidateArgs(), {
      runGh: makeRunGh({ checks: passChecks(), inlineComments: "[]" }, []),
      readReviewerPrompt: () => REVIEWER,
      callAgent: async () => staleBlocked,
    })
  );
  const out = readFileSync(defaultOutPath(repo, "AIO-161", 1), "utf8");
  check("clean+stale BLOCKED returns 0", code === 0);
  check("clean+stale BLOCKED file says CLEAR", /##\s*Verdict\s*\n+\s*CLEAR/.test(out));
  check("clean+stale BLOCKED file ends BUGBOT_CLEAR", out.trim().endsWith("BUGBOT_CLEAR"));
}

// ── output path: --round + --out override ───────────────────────────────────────
console.log("output path");
{
  const repo = freshRepo();
  await quiet(() =>
    cmdConsolidateFindings(repo, consolidateArgs("9", "a/b", ["--round", "2"]), {
      runGh: makeRunGh({ checks: passChecks() }, []),
      readReviewerPrompt: () => REVIEWER,
      callAgent: async () => readFix("agent-clear.md"),
    })
  );
  check("writes findings-r2.md", existsSync(defaultOutPath(repo, "AIO-161", 2)));

  const repo2 = freshRepo();
  const outFile = path.join(repo2, "custom-findings.md");
  await quiet(() =>
    cmdConsolidateFindings(repo2, consolidateArgs("9", "a/b", ["--out", outFile]), {
      runGh: makeRunGh({ checks: passChecks() }, []),
      readReviewerPrompt: () => REVIEWER,
      callAgent: async () => readFix("agent-clear.md"),
    })
  );
  check("--out overrides the default path", existsSync(outFile));
}

// ── config-driven model call (not a hardcode) ───────────────────────────────────
console.log("config-driven model call");
{
  const repo = freshRepo();
  mkdirSync(path.join(repo, ".aios"), { recursive: true });
  writeFileSync(path.join(repo, ".aios", "loop-models.yaml"), "consolidate_effort: high\n");
  let recorded = null;
  await quiet(() =>
    cmdConsolidateFindings(repo, consolidateArgs("9", "a/b"), {
      runGh: makeRunGh({ checks: passChecks() }, []),
      readReviewerPrompt: () => REVIEWER,
      callAgent: async (_p, _t, opts) => {
        recorded = opts;
        return readFix("agent-clear.md");
      },
    })
  );
  check("model is the resolver default (claude-haiku-4-5)", recorded.model === "claude-haiku-4-5");
  check(
    "effort from the config file is passed",
    JSON.stringify(recorded.extraArgs) === JSON.stringify(["--effort", "high"])
  );

  let lightRecorded = null;
  await quiet(() =>
    cmdConsolidateFindings(repo, consolidateArgs("9", "a/b", ["--loop-profile", "light"]), {
      runGh: makeRunGh({ checks: passChecks() }, []),
      readReviewerPrompt: () => REVIEWER,
      callPromptModel: async (call) => {
        lightRecorded = call;
        return readFix("agent-clear.md");
      },
    })
  );
  check(
    "light profile routes consolidation through OpenRouter mini",
    lightRecorded?.model === "openrouter:openai/gpt-4o-mini"
  );
}

// ── bad args → returns 1 ─────────────────────────────────────────────────────────
console.log("bad args → 1");
{
  const repo = freshRepo();
  const noPr = await quiet(() =>
    cmdConsolidateFindings(repo, ["--issue", "AIO-161", "--repo", "a/b"], {
      runGh: () => "",
      readReviewerPrompt: () => REVIEWER,
      callAgent: async () => "",
    })
  );
  check("missing --pr → 1", noPr === 1);
  const badIssue = await quiet(() =>
    cmdConsolidateFindings(repo, ["--pr", "9", "--issue", "nope", "--repo", "a/b"], {
      runGh: () => "",
      readReviewerPrompt: () => REVIEWER,
      callAgent: async () => "",
    })
  );
  check("bad --issue → 1", badIssue === 1);
  const missingArtifact = await quiet(() =>
    cmdConsolidateFindings(
      repo,
      consolidateArgs("9", "a/b", [], path.join(repo, "missing-local-bugbot.md")),
      {
        runGh: makeRunGh({ checks: passChecks() }, []),
        readReviewerPrompt: () => REVIEWER,
        callAgent: async () => readFix("agent-clear.md"),
      }
    )
  );
  check("missing local Bugbot artifact → 1", missingArtifact === 1);
}

// ── --help → returns 0 ───────────────────────────────────────────────────────────
console.log("--help → 0");
{
  const code = await quiet(() => cmdConsolidateFindings(freshRepo(), ["--help"]));
  check("help returns 0", code === 0);
}

// ── GPT review is capped ─────────────────────────────────────────────────────────
console.log("GPT review capped at GPT_REVIEW_CAP");
{
  const repo = freshRepo();
  const big = path.join(repo, "gpt-big.md");
  writeFileSync(big, "y".repeat(GPT_REVIEW_CAP + 3000));
  const inputs = gatherInputs({
    runGh: makeRunGh({ checks: passChecks() }, []),
    slug: "a/b",
    pr: "1",
    localBugbotReviewPath: LOCAL_BUGBOT_CLEAR,
    gptReviewPath: big,
  });
  check(
    "gpt markdown clipped + marker",
    inputs.gptMarkdown.length <= GPT_REVIEW_CAP + 60 &&
      inputs.gptMarkdown.includes(`truncated at ${GPT_REVIEW_CAP}`)
  );
}

// ── AIO-239 R9a: verdict coherence — the computed verdict must see markdown-decorated
// severities and verdict values, or the narrative and structured verdicts diverge (observed
// live: `**[High]**` findings + `**[BLOCKED]**` narrative shipped a structured VERDICT=CLEAR).
console.log("computeVerdict: bold **[High]** finding → BLOCKED (never a decorated-CLEAR split)");
{
  const text =
    "## Findings\n\n**[High]** `scripts/x.mjs`: protected-root bypass\n\n## Verdict\n\n**[BLOCKED]**";
  check("bold High finding blocks", computeVerdict({ text, forcedBlock: false }) === "BLOCKED");
  check(
    "plain CLEAR text with no findings stays CLEAR",
    computeVerdict({ text: "## Findings\n\n(none)\n\n## Verdict\n\nCLEAR", forcedBlock: false }) ===
      "CLEAR"
  );
}

console.log("postValidate: a bold-decorated verdict/severity is READ, not treated as dropped");
{
  // Source had a High; the model kept it (bolded) and said BLOCKED (bolded). Pre-fix, both
  // reads failed → this looked like a dropped source severity and forced a redundant block.
  const modelOutput =
    "## Findings\n\n**[High]** `f.mjs`: real thing\n\n## Verdict\n\n**[BLOCKED]**";
  const res = postValidate({ modelOutput, sourceMax: "High", ciRed: false, ciPending: false });
  check("no forced block needed — the output already blocks", res.forcedBlock === false);
  check("and the final verdict is BLOCKED", computeVerdict(res) === "BLOCKED");
}

for (const p of cleanups) {
  try {
    rmSync(p, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

console.log(failed ? `${RED}${failed} check(s) failed${NC}` : `${GREEN}all checks passed${NC}`);
process.exit(failed ? 1 : 0);

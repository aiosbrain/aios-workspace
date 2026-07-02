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
  extractBugbotSeverities,
  extractGptSeverities,
  extractCodeRabbitSeverities,
  stripFrontmatter,
  GPT_REVIEW_CAP,
} from "../scripts/consolidate-findings.mjs";
import { DIFF_CAP } from "../scripts/build.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(DIR, "fixtures", "consolidate");
const readFix = (f) => readFileSync(path.join(FIX, f), "utf8");

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
  check("valid JSON array → parsed true", pass.parsed === true);
  check("plaintext board → parsed true", parseCheckResults("build fail 1s").parsed === true);
  check("empty stdout → parsed false", parseCheckResults("").parsed === false);
}

// ── pure: severity extractors ──────────────────────────────────────────────────
console.log("severity extractors");
{
  check(
    "Bugbot **High Severity** → High",
    extractBugbotSeverities(JSON.parse(readFix("bugbot-inline.json"))) === "High"
  );
  check(
    "clean Bugbot → null",
    extractBugbotSeverities(JSON.parse(readFix("bugbot-inline-clean.json"))) === null
  );
  check("GPT `High` bullet → High", extractGptSeverities(readFix("gpt-review.md")) === "High");
  check(
    "CodeRabbit Major/potential issue → High",
    extractCodeRabbitSeverities(JSON.parse(readFix("coderabbit-comments.json"))) === "High"
  );
  const pre = preExtractSeverities({
    checks: parseCheckResults(readFix("pr-checks-pass.json")),
    bugbot: JSON.parse(readFix("bugbot-inline.json")),
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
      inlineComments: readFix("bugbot-inline.json"),
      reviews: "[]",
    },
    calls
  );
  const inputs = gatherInputs({ runGh, slug: "acme/repo", pr: "44" });
  check(
    "checks argv exact",
    JSON.stringify(calls[0]) ===
      JSON.stringify([
        "pr",
        "checks",
        "44",
        "--repo",
        "acme/repo",
        "--json",
        "name,state,conclusion",
      ])
  );
  check(
    "diff argv exact",
    JSON.stringify(calls[1]) === JSON.stringify(["pr", "diff", "44", "--repo", "acme/repo"])
  );
  check(
    "issue-comments api argv",
    calls[2][0] === "api" &&
      calls[2][1] === "repos/acme/repo/issues/44/comments" &&
      calls[2][2] === "--jq"
  );
  check("inline-comments api argv", calls[3][1] === "repos/acme/repo/pulls/44/comments");
  check("reviews api argv", calls[4][1] === "repos/acme/repo/pulls/44/reviews");
  check("PR diff captured", inputs.prDiff.includes("while (true)"));

  const prompt = buildConsolidatePrompt(REVIEWER, { ...inputs, issue: "AIO-161" });
  check("prompt includes the reviewer body", prompt.includes("AIOS Workspace Code Reviewer"));
  check("prompt includes the PR diff (Major 1)", prompt.includes("while (true)"));
  check("prompt asks for source tags", prompt.includes("(source: Bugbot|CodeRabbit|GPT-5.5)"));
}

// ── PR diff is capped at DIFF_CAP with a marker ─────────────────────────────────
console.log("gatherInputs — PR diff capped at DIFF_CAP");
{
  const big = "x".repeat(DIFF_CAP + 5000);
  const inputs = gatherInputs({
    runGh: makeRunGh({ checks: passChecks(), prDiff: big }, []),
    slug: "a/b",
    pr: "1",
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
    cmdConsolidateFindings(repo, ["--pr", "44", "--issue", "AIO-161", "--repo", "acme/repo"], {
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
    cmdConsolidateFindings(repo, ["--pr", "44", "--issue", "AIO-161", "--repo", "acme/repo"], {
      runGh: makeRunGh({ checks: passChecks(), inlineComments: readFix("bugbot-inline.json") }, []),
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
    cmdConsolidateFindings(repo, ["--pr", "44", "--issue", "AIO-161", "--repo", "acme/repo"], {
      // Bugbot fixture has **High Severity**, but the model returns a CLEAR doc.
      runGh: makeRunGh({ checks: passChecks(), inlineComments: readFix("bugbot-inline.json") }, []),
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
    cmdConsolidateFindings(repo, ["--pr", "44", "--issue", "AIO-161", "--repo", "acme/repo"], {
      // pr checks returns a NON-zero object (red board); model says CLEAR.
      runGh: makeRunGh({ checks: failChecks(), inlineComments: "[]" }, []),
      readReviewerPrompt: () => REVIEWER,
      callAgent: async () => readFix("agent-clear.md"),
    })
  );
  check("red CI returns 3, not 1", code === 3);
  check("findings file still written", existsSync(defaultOutPath(repo, "AIO-161", 1)));
}

// ── gh pr checks FAILS with no check data (auth/network) → fail closed, returns 1 ─────
console.log("CI evidence unavailable (gh failure) → 1");
{
  const repo = freshRepo();
  const code = await quiet(() =>
    cmdConsolidateFindings(repo, ["--pr", "44", "--issue", "AIO-161", "--repo", "acme/repo"], {
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

// ── "no checks reported" (no CI configured) is benign → proceeds normally ─────────────
console.log("no checks reported (benign) → proceeds");
{
  const repo = freshRepo();
  const code = await quiet(() =>
    cmdConsolidateFindings(repo, ["--pr", "44", "--issue", "AIO-161", "--repo", "acme/repo"], {
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
    "## Findings\n\n[High] scripts/x.mjs:1 — boom (source: Bugbot)\n\n## Verdict\n\nCLEAR\n";
  const code = await quiet(() =>
    cmdConsolidateFindings(repo, ["--pr", "44", "--issue", "AIO-161", "--repo", "acme/repo"], {
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
    cmdConsolidateFindings(repo, ["--pr", "44", "--issue", "AIO-161", "--repo", "acme/repo"], {
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
    cmdConsolidateFindings(
      repo,
      ["--pr", "9", "--issue", "AIO-161", "--round", "2", "--repo", "a/b"],
      {
        runGh: makeRunGh({ checks: passChecks() }, []),
        readReviewerPrompt: () => REVIEWER,
        callAgent: async () => readFix("agent-clear.md"),
      }
    )
  );
  check("writes findings-r2.md", existsSync(defaultOutPath(repo, "AIO-161", 2)));

  const repo2 = freshRepo();
  const outFile = path.join(repo2, "custom-findings.md");
  await quiet(() =>
    cmdConsolidateFindings(
      repo2,
      ["--pr", "9", "--issue", "AIO-161", "--out", outFile, "--repo", "a/b"],
      {
        runGh: makeRunGh({ checks: passChecks() }, []),
        readReviewerPrompt: () => REVIEWER,
        callAgent: async () => readFix("agent-clear.md"),
      }
    )
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
    cmdConsolidateFindings(repo, ["--pr", "9", "--issue", "AIO-161", "--repo", "a/b"], {
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
    gptReviewPath: big,
  });
  check(
    "gpt markdown clipped + marker",
    inputs.gptMarkdown.length <= GPT_REVIEW_CAP + 60 &&
      inputs.gptMarkdown.includes(`truncated at ${GPT_REVIEW_CAP}`)
  );
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

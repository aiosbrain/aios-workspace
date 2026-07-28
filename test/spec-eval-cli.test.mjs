// test/spec-eval-cli.test.mjs — end-to-end through `aios spec` in a child process: the exit-code
// contract (0/1/3/4), the --json shape (incl. exitCode), and fix's file I/O (default writes
// <name>.improved.md, --write overwrites, the original is untouched unless --write). The LLM layer
// is driven by the AIOS_SPEC_EVAL_STUB / AIOS_SPEC_FIX_STUB seams — no API key, no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  copyFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(DIR, "..");
const AIOS = path.join(REPO, "scripts", "aios.mjs");
const FIXTURES = path.join(DIR, "fixtures", "spec-eval");
const STRONG = path.join(FIXTURES, "strong-spec.md");
const DEMO = path.join(FIXTURES, "acceptance-demo-weak.md");

function runSpec(args, env = {}) {
  const r = spawnSync(process.execPath, [AIOS, "spec", ...args, "--repo", REPO], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

test("eval --adversarial --no-llm on a clean spec → exit 3 (NOT_EVALUATED)", () => {
  // Since AIO-573 the adversarial layer is opt-in, so NOT_EVALUATED means exactly "you ASKED
  // for the LLM layer and it did not run". Asking (--adversarial) and suppressing (--no-llm) is
  // the only way to get there; a caller who never asked gets a complete deterministic answer.
  assert.equal(runSpec(["eval", STRONG, "--adversarial", "--no-llm"]).code, 3);
});

test("AIO-573 — the default is deterministic: clean spec, no key, exit 0", () => {
  const r = runSpec(["eval", STRONG, "--json"], { DEEPSEEK_API_KEY: "", ANTHROPIC_API_KEY: "" });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).tier, "deterministic", "no opt-in ⇒ deterministic tier");
});

test("deterministic eval tier is SPEC_READY without a model key", () => {
  const d = mkdtempSync(path.join(tmpdir(), "spec-tier-"));
  try {
    const target = path.join(d, "deterministic.md");
    writeFileSync(target, `---\neval_tier: deterministic\n---\n\n${readFileSync(STRONG, "utf8")}`);
    const r = runSpec(["eval", target, "--json"], { DEEPSEEK_API_KEY: "", ANTHROPIC_API_KEY: "" });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).tier, "deterministic");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("valid spec_gate frontmatter parses; a bad value errors (exit 4, like eval_tier)", () => {
  const d = mkdtempSync(path.join(tmpdir(), "spec-gate-"));
  try {
    const strong = readFileSync(STRONG, "utf8");
    const good = path.join(d, "advisory.md");
    writeFileSync(good, `---\neval_tier: deterministic\nspec_gate: advisory\n---\n\n${strong}`);
    // spec_gate is an enforcement-policy hint (consumed by `aios ship`), not an eval knob — a valid
    // value must not disturb `aios spec eval`, which still reports readiness normally.
    assert.equal(runSpec(["eval", good, "--json"], { DEEPSEEK_API_KEY: "" }).code, 0);

    const bad = path.join(d, "bad.md");
    writeFileSync(bad, `---\nspec_gate: sometimes\n---\n\n${strong}`);
    const r = runSpec(["eval", bad, "--no-llm"]);
    assert.equal(r.code, 4, r.stderr);
    assert.match(r.stderr, /spec_gate/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("eval in a rubric-less repo falls back to the toolkit rubric (no exit 4)", () => {
  // Reproduces the Team Brain case: --repo points at a repo with no .claude/rubrics/. Before the
  // fallback this hard-failed with exit 4 ("rubric not found"); now it grades against the toolkit's
  // own rubric. Offline (--no-llm) so no key is needed. Spawn directly with a single --repo bare.
  const bare = mkdtempSync(path.join(tmpdir(), "brain-like-repo-"));
  try {
    const spec = path.join(bare, "issue.md");
    writeFileSync(spec, readFileSync(STRONG, "utf8"));
    const r = spawnSync(
      process.execPath,
      [AIOS, "spec", "eval", spec, "--no-llm", "--repo", bare],
      {
        encoding: "utf8",
        env: { ...process.env },
      }
    );
    // The fix: it no longer dies on rubric loading. (The exact verdict/exit depends on how the
    // spec's own path claims resolve against the bare repo — not what this test is asserting.)
    assert.notEqual(r.status, 4, r.stderr);
    assert.doesNotMatch(r.stderr, /rubric not found/);
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});

test("directory eval emits one batch summary and accepts deterministic specs", () => {
  const d = mkdtempSync(path.join(tmpdir(), "spec-batch-"));
  try {
    const text = `---\neval_tier: deterministic\n---\n\n${readFileSync(STRONG, "utf8")}`;
    writeFileSync(path.join(d, "one.md"), text);
    writeFileSync(path.join(d, "two.md"), text);
    const r = runSpec(["eval", d, "--json", "--concurrency", "2"], { DEEPSEEK_API_KEY: "" });
    assert.equal(r.code, 0, r.stderr);
    const json = JSON.parse(r.stdout);
    assert.equal(json.exitCode, 0);
    assert.equal(json.results.length, 2);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("author fans slices out and honors a per-invocation model override", () => {
  const d = mkdtempSync(path.join(tmpdir(), "spec-author-cli-"));
  try {
    const plan = path.join(d, "plan.md");
    const slices = path.join(d, "slices");
    const out = path.join(d, "out");
    writeFileSync(plan, "# Shared plan\n");
    mkdirSync(slices);
    writeFileSync(path.join(slices, "one.md"), "# Issue one\n");
    writeFileSync(path.join(slices, "two.md"), "# Issue two\n");
    const r = runSpec(
      [
        "author",
        plan,
        "--slices",
        slices,
        "--out",
        out,
        "--model",
        "claude:claude-sonnet-5",
        "--effort",
        "high",
        "--json",
      ],
      { AIOS_SPEC_AUTHOR_STUB: STRONG }
    );
    assert.equal(r.code, 0, r.stderr);
    const json = JSON.parse(r.stdout);
    assert.equal(json.model, "claude:claude-sonnet-5");
    assert.equal(json.effort, "high");
    assert.ok(existsSync(path.join(out, "one.md")));
    assert.ok(existsSync(path.join(out, "two.md")));
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("author rejects an invalid per-invocation effort", () => {
  const d = mkdtempSync(path.join(tmpdir(), "spec-author-effort-"));
  try {
    const plan = path.join(d, "plan.md");
    const slices = path.join(d, "slices");
    writeFileSync(plan, "# Shared plan\n");
    mkdirSync(slices);
    writeFileSync(path.join(slices, "one.md"), "# Issue one\n");
    const r = runSpec(["author", plan, "--slices", slices, "--effort", "turbo"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /invalid --effort/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("eval without stub or key → exit 4 (DEEPSEEK_API_KEY required)", () => {
  const env = { ...process.env, DEEPSEEK_API_KEY: "" };
  delete env.AIOS_SPEC_EVAL_STUB;
  // --adversarial opts into the LLM layer, which is what needs the key.
  const r = runSpec(["eval", STRONG, "--adversarial"], env);
  assert.equal(r.code, 4);
  assert.match(r.stderr, /DEEPSEEK_API_KEY/);
});

test("eval --no-llm on a spec with a deterministic blocker → exit 1", () => {
  assert.equal(runSpec(["eval", DEMO, "--no-llm"]).code, 1);
});

test("fix --no-llm needs no API key (deterministic verify only)", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "spec-fix-nollm-"));
  try {
    const copy = path.join(tmp, "strong.md");
    copyFileSync(STRONG, copy);
    const r = runSpec(["fix", copy, "--no-llm"], { ANTHROPIC_API_KEY: "" });
    assert.notEqual(r.code, 4, `must not demand a key with --no-llm: ${r.stderr}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("eval with a SPEC_READY stub on a clean spec → exit 0", () => {
  const env = { AIOS_SPEC_EVAL_STUB: '{"verdict":"SPEC_READY","score":92,"findings":[]}' };
  // --adversarial is required for this to exercise the stub at all; without it the deterministic
  // layer would return 0 on its own and the assertion would be vacuous.
  assert.equal(runSpec(["eval", STRONG, "--adversarial"], env).code, 0);
});

test("eval with an adversarial-blocker stub on a clean spec → exit 2", () => {
  const env = {
    AIOS_SPEC_EVAL_STUB:
      '{"verdict":"NOT_READY","score":30,"findings":[{"ruleId":"SR15","severity":"blocker","why":"x"}]}',
  };
  assert.equal(runSpec(["eval", STRONG, "--adversarial"], env).code, 2);
});

test("eval with junk from the evaluator → exit 2 (synthetic blocker, fail closed)", () => {
  const env = { AIOS_SPEC_EVAL_STUB: "totally not json" };
  assert.equal(runSpec(["eval", STRONG, "--adversarial"], env).code, 2);
});

test("AIO-573 — `eval_tier: full` frontmatter opts in without a flag", () => {
  const d = mkdtempSync(path.join(tmpdir(), "spec-optin-"));
  try {
    const target = path.join(d, "full.md");
    writeFileSync(target, `---\neval_tier: full\n---\n\n${readFileSync(STRONG, "utf8")}`);
    const env = {
      AIOS_SPEC_EVAL_STUB:
        '{"verdict":"NOT_READY","score":30,"findings":[{"ruleId":"SR15","severity":"blocker","why":"x"}]}',
    };
    assert.equal(runSpec(["eval", target], env).code, 2, "the spec asked for the LLM layer");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("AIO-573 — a deterministic blocker still blocks with the layer opted out", () => {
  // The gate did not get weaker: the deterministic layer runs by default and still exits 1.
  assert.equal(runSpec(["eval", DEMO], { DEEPSEEK_API_KEY: "" }).code, 1);
});

test("missing spec file → exit 4", () => {
  assert.equal(runSpec(["eval", "/no/such/spec.md", "--no-llm"]).code, 4);
});

test("unknown subcommand → exit 4", () => {
  assert.equal(runSpec(["frobnicate", STRONG]).code, 4);
});

test("--json output carries verdict + exitCode + findings", () => {
  const r = runSpec(["eval", DEMO, "--no-llm", "--json"]);
  assert.equal(r.code, 1);
  const j = JSON.parse(r.stdout);
  assert.equal(j.verdict, "NOT_READY");
  assert.equal(j.exitCode, 1);
  assert.ok(Array.isArray(j.findings) && j.findings.length > 0);
});

test("fix default writes <name>.improved.md, leaves the original untouched", () => {
  const d = mkdtempSync(path.join(tmpdir(), "spec-fix-"));
  const target = path.join(d, "s.md");
  const original = readFileSync(DEMO, "utf8");
  writeFileSync(target, original);
  const r = runSpec(["fix", target, "--no-llm"], { AIOS_SPEC_FIX_STUB: STRONG });
  assert.equal(r.code, 0); // reviser returns a clean spec → converges
  const improved = path.join(d, "s.improved.md");
  assert.ok(existsSync(improved), "expected <name>.improved.md");
  assert.equal(readFileSync(improved, "utf8"), readFileSync(STRONG, "utf8"));
  assert.equal(readFileSync(target, "utf8"), original, "original must be untouched");
  rmSync(d, { recursive: true, force: true });
});

test("fix --write overwrites in place", () => {
  const d = mkdtempSync(path.join(tmpdir(), "spec-fix-w-"));
  const target = path.join(d, "s.md");
  writeFileSync(target, readFileSync(DEMO, "utf8"));
  const r = runSpec(["fix", target, "--no-llm", "--write"], { AIOS_SPEC_FIX_STUB: STRONG });
  assert.equal(r.code, 0);
  assert.ok(!existsSync(path.join(d, "s.improved.md")), "no sidecar file when --write");
  assert.equal(readFileSync(target, "utf8"), readFileSync(STRONG, "utf8"));
  rmSync(d, { recursive: true, force: true });
});

test("fix --json carries exitCode and the output path", () => {
  const d = mkdtempSync(path.join(tmpdir(), "spec-fix-j-"));
  const target = path.join(d, "s.md");
  writeFileSync(target, readFileSync(DEMO, "utf8"));
  const r = runSpec(["fix", target, "--no-llm", "--json"], { AIOS_SPEC_FIX_STUB: STRONG });
  const j = JSON.parse(r.stdout);
  assert.equal(j.exitCode, 0);
  assert.equal(j.outputPath, path.join(d, "s.improved.md"));
  rmSync(d, { recursive: true, force: true });
});

test("AIO-573 — `fix` demands a key on the default tier (the reviser is an LLM either way)", () => {
  // eval_tier selects the EVALUATOR layer; the REVISER is a model regardless, and runFixLoop
  // calls it on any NOT_READY. Gating the upfront key check on the tier let a default-tier fix
  // skip exit 4 and die later inside the model call with a much worse error.
  const env = { ...process.env, DEEPSEEK_API_KEY: "", ANTHROPIC_API_KEY: "" };
  delete env.AIOS_SPEC_EVAL_STUB;
  delete env.AIOS_SPEC_FIX_STUB;
  const tmp = mkdtempSync(path.join(tmpdir(), "spec-fix-key-"));
  try {
    const copy = path.join(tmp, "weak.md");
    copyFileSync(DEMO, copy);
    const r = runSpec(["fix", copy], env);
    assert.equal(r.code, 4, `expected the upfront key check, got: ${r.stderr}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("AIO-573 — `fix --no-llm` still needs no key", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "spec-fix-nokey-"));
  try {
    const copy = path.join(tmp, "strong.md");
    copyFileSync(STRONG, copy);
    const r = runSpec(["fix", copy, "--no-llm"], { ANTHROPIC_API_KEY: "", DEEPSEEK_API_KEY: "" });
    assert.notEqual(r.code, 4, `--no-llm must not demand a key: ${r.stderr}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

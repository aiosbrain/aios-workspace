#!/usr/bin/env node
// test/loop-models.test.mjs — per-step model config resolver + diversity guard.
// Zero-dep, no network. The diversity guard calls die() (process.exit(1)); we test it
// in a child process so the harness survives. Run: node test/loop-models.test.mjs

import { resolveLoopModels, DEFAULT_MODELS, STEPS, modelFamily } from "../scripts/loop-models.mjs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const LOADER = path.join(DIR, "..", "scripts", "loop-models.mjs");

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

// Resolve the loader in a child so a die()/exit(1) is observable as an exit code.
function resolveInChild({ repo, configPath, cliOverrides }) {
  const script =
    `import { resolveLoopModels } from ${JSON.stringify(LOADER)};` +
    `const r = resolveLoopModels(${JSON.stringify({ repo, configPath, cliOverrides })});` +
    `process.stdout.write(JSON.stringify(r));`;
  try {
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, resolved: JSON.parse(out) };
  } catch (e) {
    return { ok: false, stderr: `${e.stderr ?? ""}` };
  }
}

console.log("no config file → defaults");
{
  const empty = mkdtempSync(path.join(tmpdir(), "lm-empty-"));
  const r = resolveLoopModels({ repo: empty });
  let allMatch = true;
  for (const step of STEPS) {
    const def = DEFAULT_MODELS[step];
    if (r[step].model !== def.model) allMatch = false;
    if ((r[step].effort ?? undefined) !== (def.effort ?? undefined)) allMatch = false;
  }
  check("every step matches the default matrix", allMatch);
  check("plan carries xhigh effort", r.plan.effort === "xhigh");
  check("build carries high effort", r.build.effort === "high");
  check("fix carries medium effort", r.fix.effort === "medium");
  check("recon has no effort key", r.recon.effort === undefined);
  rmSync(empty, { recursive: true, force: true });
}

console.log("file override changes only the targeted field");
{
  const repo = mkdtempSync(path.join(tmpdir(), "lm-file-"));
  mkdirSync(path.join(repo, ".aios"), { recursive: true });
  // claude-sonnet-5 stays in the anthropic family, so the build/code_review guard holds.
  writeFileSync(
    path.join(repo, ".aios", "loop-models.yaml"),
    "build_model: claude-sonnet-5\ncode_review_timeout_s: 420\n"
  );
  const r = resolveLoopModels({ repo });
  check("build.model overridden", r.build.model === "claude-sonnet-5");
  check("build.effort untouched", r.build.effort === "high");
  check("code_review timeout → ms", r.code_review.timeoutMs === 420000);
  check("plan.model unchanged", r.plan.model === DEFAULT_MODELS.plan.model);
  check("digest.model unchanged", r.digest.model === DEFAULT_MODELS.digest.model);
  rmSync(repo, { recursive: true, force: true });
}

console.log("precedence: CLI > file > default");
{
  const repo = mkdtempSync(path.join(tmpdir(), "lm-prec-"));
  mkdirSync(path.join(repo, ".aios"), { recursive: true });
  writeFileSync(path.join(repo, ".aios", "loop-models.yaml"), "build_model: claude-sonnet-5\n");
  const r = resolveLoopModels({
    repo,
    cliOverrides: { build: { model: "claude-haiku-4-5", effort: "max" } },
  });
  check("CLI model beats file", r.build.model === "claude-haiku-4-5");
  check("CLI effort beats default", r.build.effort === "max");
  // A step with only a file value still takes the file value over the default.
  const r2 = resolveLoopModels({ repo });
  check("file model beats default", r2.build.model === "claude-sonnet-5");
  rmSync(repo, { recursive: true, force: true });
}

console.log("diversity guard (fail closed)");
{
  check("defaults pass the guard", resolveInChild({ repo: null }).ok === true);

  const repo = mkdtempSync(path.join(tmpdir(), "lm-div-"));
  mkdirSync(path.join(repo, ".aios"), { recursive: true });

  // build vs code_review collide (both anthropic).
  writeFileSync(
    path.join(repo, ".aios", "loop-models.yaml"),
    "code_review_model: claude-opus-4-8\n"
  );
  const bad1 = resolveInChild({ repo });
  check("build/code_review same-family aborts", bad1.ok === false);
  check("abort message is actionable", /different model families/.test(bad1.stderr));

  // plan vs plan_review collide (both anthropic).
  writeFileSync(
    path.join(repo, ".aios", "loop-models.yaml"),
    "plan_review_model: claude-opus-4-8\n"
  );
  const bad2 = resolveInChild({ repo });
  check("plan/plan_review same-family aborts", bad2.ok === false);

  rmSync(repo, { recursive: true, force: true });
}

console.log("runner-family guard (fail closed) — M1");
{
  const repo = mkdtempSync(path.join(tmpdir(), "lm-runner-"));
  mkdirSync(path.join(repo, ".aios"), { recursive: true });

  // A GPT model on a Claude-runner step (build) via FILE must abort.
  writeFileSync(path.join(repo, ".aios", "loop-models.yaml"), "build_model: gpt-5.3-codex\n");
  const badFile = resolveInChild({ repo });
  check("gpt build_model via file aborts", badFile.ok === false);
  check("message names the Claude-family requirement", /Claude-family/.test(badFile.stderr));

  // Same via a CLI --model override (no config file needed).
  const badCli = resolveInChild({
    repo: null,
    cliOverrides: { build: { model: "gpt-5.3-codex" } },
  });
  check("gpt build model via CLI aborts", badCli.ok === false);

  // A Claude-family id is accepted.
  writeFileSync(path.join(repo, ".aios", "loop-models.yaml"), "build_model: claude-sonnet-5\n");
  check("claude build_model passes", resolveInChild({ repo }).ok === true);

  // The `plan` step is a Claude runner too (SDK) — a GPT plan model aborts.
  const badPlan = resolveInChild({ repo: null, cliOverrides: { plan: { model: "gpt-5.5-high" } } });
  check("gpt plan model aborts", badPlan.ok === false);

  // `consolidate` is now a Claude-runner step too (Major 5) — a GPT consolidate_model aborts
  // before it can be handed to callClaudeAgent.
  writeFileSync(path.join(repo, ".aios", "loop-models.yaml"), "consolidate_model: gpt-5.5-high\n");
  const badConsolidate = resolveInChild({ repo });
  check("gpt consolidate_model via file aborts", badConsolidate.ok === false);
  check(
    "consolidate abort names the Claude-family requirement",
    /Claude-family/.test(badConsolidate.stderr)
  );

  // The default consolidate model still resolves (anthropic) and other guards are unaffected.
  const okDefault = resolveInChild({ repo: null });
  check(
    "default consolidate resolves (anthropic)",
    okDefault.ok === true && modelFamily(okDefault.resolved.consolidate.model) === "anthropic"
  );

  rmSync(repo, { recursive: true, force: true });
}

console.log("ship/roadmap Claude-runner steps (R-Major-6) fail closed on a non-Claude override");
{
  // recon, safety_review, and digest are executed via callClaudeAgent in ship/roadmap-run,
  // so a non-Claude override for any of them must abort at resolve time, before any run.
  const badRecon = resolveInChild({
    repo: null,
    cliOverrides: { recon: { model: "gpt-5.5-high" } },
  });
  check("gpt recon model aborts", badRecon.ok === false);
  check("recon abort names the Claude-family requirement", /Claude-family/.test(badRecon.stderr));

  const badSafety = resolveInChild({
    repo: null,
    cliOverrides: { safety_review: { model: "gpt-5.5-high" } },
  });
  check("gpt safety_review model aborts", badSafety.ok === false);
  check(
    "safety_review abort names the Claude-family requirement",
    /Claude-family/.test(badSafety.stderr)
  );

  const badDigest = resolveInChild({
    repo: null,
    cliOverrides: { digest: { model: "gpt-5.3-codex" } },
  });
  check("gpt digest model aborts", badDigest.ok === false);

  // A Claude-family override for each is accepted.
  const okRecon = resolveInChild({
    repo: null,
    cliOverrides: { recon: { model: "claude-sonnet-5" } },
  });
  check("claude recon model passes", okRecon.ok === true);

  // The diversity pairs are unaffected by the new Claude-runner steps.
  const okDefaults = resolveInChild({ repo: null });
  check("defaults still pass all guards", okDefaults.ok === true);
}

console.log("config validation fails loudly (M4)");
{
  const repo = mkdtempSync(path.join(tmpdir(), "lm-val-"));
  mkdirSync(path.join(repo, ".aios"), { recursive: true });
  const yaml = path.join(repo, ".aios", "loop-models.yaml");
  const write = (s) => writeFileSync(yaml, s);

  write("bogus_key: 1\n");
  check("unknown key aborts", resolveInChild({ repo }).ok === false);

  write("notastep_model: claude-opus-4-8\n");
  check("unknown step name aborts", resolveInChild({ repo }).ok === false);

  write("build_effort: turbo\n");
  const badEff = resolveInChild({ repo });
  check("invalid effort value aborts", badEff.ok === false);
  check("effort message lists allowed values", /low\|medium\|high\|xhigh\|max/.test(badEff.stderr));

  write("build_timeout_s: 0\n");
  check("non-positive timeout aborts", resolveInChild({ repo }).ok === false);

  write("build_timeout_s: soon\n");
  check("non-numeric timeout aborts", resolveInChild({ repo }).ok === false);

  // A syntactically malformed line (no colon) must NOT be silently dropped by the parser
  // and resolve to defaults — strict parsing rejects it before validation even runs.
  write("build_model claude-sonnet-5\n");
  const badLine = resolveInChild({ repo });
  check("malformed line (missing colon) aborts", badLine.ok === false);
  check("parse-failure message is surfaced", /could not parse/.test(badLine.stderr));

  // A stray list item with no key header is malformed too.
  write("  - claude-sonnet-5\n");
  check("stray list item aborts", resolveInChild({ repo }).ok === false);

  // A CLI override naming an unknown step aborts too.
  check(
    "unknown CLI step aborts",
    resolveInChild({ repo: null, cliOverrides: { nope: { model: "claude-opus-4-8" } } }).ok ===
      false
  );

  // AIO-186 F7: an empty/blank *_model would beat the default via the `??` chain, then silently
  // drop --model in the runner. It must abort at validation — including on a non-Claude-runner,
  // non-diversity-paired step like plan_review (which otherwise slips both later guards).
  write('plan_review_model: ""\n');
  const emptyFileModel = resolveInChild({ repo });
  check("empty file *_model aborts", emptyFileModel.ok === false);
  check(
    "empty-model message says non-empty string required",
    /must be a non-empty string/.test(emptyFileModel.stderr)
  );

  const blankCliModel = resolveInChild({
    repo: null,
    cliOverrides: { plan_review: { model: "  " } },
  });
  check("blank CLI --model aborts", blankCliModel.ok === false);
  check(
    "blank CLI model message says non-empty string required",
    /must be a non-empty string/.test(blankCliModel.stderr)
  );

  // An unreadable file (configPath pointing at a directory → EISDIR) aborts, not silent defaults.
  const asDir = mkdtempSync(path.join(tmpdir(), "lm-dir-"));
  check("unreadable config file aborts", resolveInChild({ configPath: asDir }).ok === false);
  rmSync(asDir, { recursive: true, force: true });

  rmSync(repo, { recursive: true, force: true });
}

console.log("spec harness steps (EE5) resolve + runner-family guard");
{
  const empty = mkdtempSync(path.join(tmpdir(), "lm-spec-"));
  const r = resolveLoopModels({ repo: empty });
  check(
    "spec_eval resolves to opus/xhigh",
    r.spec_eval.model === "claude-opus-4-8" && r.spec_eval.effort === "xhigh"
  );
  check(
    "spec_fix resolves to opus/high",
    r.spec_fix.model === "claude-opus-4-8" && r.spec_fix.effort === "high"
  );
  check("spec_eval is a known step", STEPS.includes("spec_eval"));
  check("spec_fix is a known step", STEPS.includes("spec_fix"));
  rmSync(empty, { recursive: true, force: true });

  // spec_eval/spec_fix run on the Claude SDK → a gpt override must abort (runner-family guard).
  const badEval = resolveInChild({
    repo: null,
    cliOverrides: { spec_eval: { model: "gpt-5.5-high" } },
  });
  check("gpt spec_eval model aborts", badEval.ok === false);
  check(
    "spec_eval abort names the Claude-family requirement",
    /Claude-family/.test(badEval.stderr)
  );
  const badFix = resolveInChild({
    repo: null,
    cliOverrides: { spec_fix: { model: "gpt-5.3-codex" } },
  });
  check("gpt spec_fix model aborts", badFix.ok === false);
}

console.log("modelFamily");
{
  check("claude → anthropic", modelFamily("claude-opus-4-8") === "anthropic");
  check("fable → anthropic", modelFamily("fable-5") === "anthropic");
  check("gpt → openai", modelFamily("gpt-5.5-high") === "openai");
  check("deepseek → deepseek", modelFamily("deepseek-v4-pro") === "deepseek");
  check("unknown → other", modelFamily("mystery-1") === "other");
}

console.log("default reviewer models (2026-07-04 — Cursor Ultra cap)");
{
  check(
    "code_review defaults to deepseek-v4-pro",
    DEFAULT_MODELS.code_review.model === "deepseek-v4-pro"
  );
  check(
    "plan_review defaults to deepseek-v4-pro",
    DEFAULT_MODELS.plan_review.model === "deepseek-v4-pro"
  );
  check(
    "build/code_review stay cross-family",
    modelFamily(DEFAULT_MODELS.build.model) !== modelFamily(DEFAULT_MODELS.code_review.model)
  );
  check(
    "plan/plan_review stay cross-family",
    modelFamily(DEFAULT_MODELS.plan.model) !== modelFamily(DEFAULT_MODELS.plan_review.model)
  );
}

console.log(failed ? `${RED}${failed} check(s) failed${NC}` : `${GREEN}all checks passed${NC}`);
process.exit(failed ? 1 : 0);

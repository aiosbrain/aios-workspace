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
function resolveInChild({ repo, configPath }) {
  const script =
    `import { resolveLoopModels } from ${JSON.stringify(LOADER)};` +
    `const r = resolveLoopModels(${JSON.stringify({ repo, configPath })});` +
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

console.log("modelFamily");
{
  check("claude → anthropic", modelFamily("claude-opus-4-8") === "anthropic");
  check("fable → anthropic", modelFamily("fable-5") === "anthropic");
  check("gpt → openai", modelFamily("gpt-5.5-high") === "openai");
  check("unknown → other", modelFamily("mystery-1") === "other");
}

console.log(failed ? `${RED}${failed} check(s) failed${NC}` : `${GREEN}all checks passed${NC}`);
process.exit(failed ? 1 : 0);

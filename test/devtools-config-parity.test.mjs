#!/usr/bin/env node
// test/devtools-config-parity.test.mjs — the loop-model CONFIG SURFACE must not drift between
// core and the pinned @aiosbrain/aios-devtools (AIO-699 follow-up).
//
// Why this exists, concretely: `<step>_preset` shipped in core while devtools 0.2.0's KEY_RE
// still only accepted model/effort/timeout_s. A `spec_eval_preset:` line — copied straight out
// of core's own docs/loop-models.example.yaml — therefore aborted EVERY devtools command with
// `unknown key`, not just that step. Core's suite could not see it: core tests core's resolver,
// but `aios spec eval` and `aios ship` dispatch into the PUBLISHED package.
//
// The existing devtools-side `toolkit-drift` CI lane does not cover this either. It runs the
// devtools suite against core `main`, which catches devtools breaking on a core change — the
// opposite direction from a core change the devtools runtime cannot parse.
//
// So this is the mechanical guard for the ordering rule in docs/devtools-migration.md: a core
// change that widens the config surface FAILS here until the devtools companion is published and
// the exact pin is bumped. The AGENTS.md error-ledger note is the reasoning; this is the gate.
//
// Zero-dep, no network. Run: node test/devtools-config-parity.test.mjs

import { STEPS } from "../scripts/loop-models.mjs";
import { REVIEWER_PRESETS } from "../scripts/model-providers.mjs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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

// Everything below runs the INSTALLED package, never a relative path, because the pin is the
// thing under test — a local devtools checkout passing proves nothing about what operators get.
function inDevtoolsChild(body) {
  const script =
    `const { REVIEWER_PRESETS, resolveReviewerPreset } = ` +
    `await import("@aiosbrain/aios-devtools/model-providers");` +
    `const { resolveLoopModels, STEPS } = await import("@aiosbrain/aios-devtools/loop-models");` +
    body;
  try {
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      cwd: path.join(import.meta.dirname, ".."),
    });
    return { ok: true, out: out.trim() };
  } catch (e) {
    return { ok: false, stderr: `${e.stderr ?? ""}` };
  }
}

console.log("pinned devtools is reachable and exposes the shared config surface");
const surface = inDevtoolsChild(
  `process.stdout.write(JSON.stringify({ presets: REVIEWER_PRESETS, steps: STEPS }));`
);
check("devtools loop-model modules resolve from the pin", surface.ok);
if (!surface.ok) {
  console.log(surface.stderr.split("\n").slice(0, 6).join("\n"));
  console.log(
    `${RED}Publish the devtools companion and bump the exact pin — see docs/devtools-migration.md.${NC}`
  );
  process.exit(1);
}
const dt = JSON.parse(surface.out);

console.log("reviewer presets are identical on both sides of the seam");
{
  const coreNames = Object.keys(REVIEWER_PRESETS).sort();
  const dtNames = Object.keys(dt.presets).sort();
  check(
    `preset names match (core: ${coreNames.join(", ")})`,
    JSON.stringify(coreNames) === JSON.stringify(dtNames)
  );
  // Descriptions are prose and may differ; the MODEL and the BILLING MODE are the contract.
  // A preset that routes to a different model, or quietly bills API credits on one side and a
  // subscription on the other, is exactly the drift that is invisible until an invoice arrives.
  for (const name of coreNames) {
    if (!dt.presets[name]) continue;
    check(
      `${name} resolves to the same model`,
      REVIEWER_PRESETS[name].model === dt.presets[name].model
    );
    check(
      `${name} declares the same billing mode`,
      REVIEWER_PRESETS[name].billing === dt.presets[name].billing
    );
  }
}

console.log("devtools accepts every <step>_preset key core can emit");
{
  // Only steps devtools actually knows — core owns steps that never reach the devtools runtime.
  const shared = STEPS.filter((s) => dt.steps.includes(s));
  check("core and devtools share at least one loop step", shared.length > 0);
  const presetName = Object.keys(REVIEWER_PRESETS)[0];
  for (const step of shared) {
    const repo = mkdtempSync(path.join(tmpdir(), "dt-parity-"));
    mkdirSync(path.join(repo, ".aios"), { recursive: true });
    writeFileSync(path.join(repo, ".aios", "loop-models.yaml"), `${step}_preset: ${presetName}\n`);
    const r = inDevtoolsChild(
      `resolveLoopModels({ repo: ${JSON.stringify(repo)} });process.stdout.write("ok");`
    );
    // What is under test is whether devtools RECOGNIZES the key, not whether this particular
    // preset is a sensible choice for this particular step. Pointing a reviewer preset at an
    // agentic step legitimately trips the agentic-provider and author/reviewer-diversity guards
    // — those firing is the guards working, and asserting `r.ok` here would have made this test
    // a test of loop-model semantics instead of a drift gate.
    //
    // An unknown key is different in kind: it is a PARSE failure that aborts the whole run
    // before any step is considered, which is why `spec_eval_preset` broke every devtools
    // command rather than just spec-eval. So that, specifically, is the assertion.
    const unknownKey = !r.ok && /unknown key '\S*_preset'/.test(r.stderr);
    check(`${step}_preset is a recognized key in the pinned devtools`, !unknownKey);
    if (unknownKey) console.log(`      ${r.stderr.trim().split("\n").slice(-1)[0]}`);
    rmSync(repo, { recursive: true, force: true });
  }
}

console.log("devtools preset lookup fails closed on inherited keys");
{
  const r = inDevtoolsChild(
    `process.stdout.write(JSON.stringify([
       resolveReviewerPreset("constructor"),
       resolveReviewerPreset("__proto__"),
       resolveReviewerPreset("toString"),
     ]));`
  );
  check(
    "inherited Object.prototype keys resolve to null, not a silent default",
    r.ok && JSON.parse(r.out).every((v) => v === null)
  );
}

if (failed) {
  console.log(
    `\n${RED}${failed} check(s) failed — the core config surface is ahead of the pinned devtools.${NC}\n` +
      `Publish the devtools companion, then bump the exact pin (docs/devtools-migration.md).`
  );
  process.exit(1);
}
console.log(`\n${GREEN}all checks passed${NC}`);

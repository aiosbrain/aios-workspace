// AIO-1027 regression: the invocation the docs name must be one that RESOLVES the credential.
//
// THE BUG THIS EXISTS FOR. There are three ways to reach the Linear CLI and only one of them
// resolves LINEAR_API_KEY:
//
//   linear <cmd>                                -> scripts/linear.mjs -> resolveConnectorEnv()  ✅
//   node scripts/linear.mjs <cmd>               -> same wrapper, but NOT vendored to workspaces
//   node .claude/skills/aios-linear/linear.mjs  -> reads process.env only, resolves NOTHING     ❌
//
// PR #639 moved every documented invocation onto the third one. It passed review and CI because
// every machine that ran it already had LINEAR_API_KEY exported (direnv), so the credential-less
// path appeared to work. Strip the key and it fails — which is what a member actually experiences.
//
// The assertion is therefore about the DOCS, checked against the CODE: whatever the SKILL.md tells
// a reader to run must not be a file that lacks credential resolution.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_MD = path.join(ROOT, "scaffold/.claude/skills/aios-linear/SKILL.md");
const CORE = path.join(ROOT, "scaffold/.claude/skills/aios-linear/linear-core.mjs");
const WRAPPER = path.join(ROOT, "scripts/linear.mjs");

test("the credential wrapper is scripts/linear.mjs, and it still resolves the key", () => {
  const wrapper = readFileSync(WRAPPER, "utf8");
  assert.match(wrapper, /resolveConnectorEnv\(/, "scripts/linear.mjs must resolve connector env");
  assert.match(wrapper, /apiKeyEnv:\s*"LINEAR_API_KEY"/, "it must resolve LINEAR_API_KEY specifically");
});

test("the skill CLI does NOT resolve credentials — so it must not be the documented entry point", () => {
  const core = readFileSync(CORE, "utf8");
  assert.match(core, /process\.env\.LINEAR_API_KEY/, "linear-core reads the key from the environment");
  assert.doesNotMatch(core, /resolveConnectorEnv/, "linear-core does not resolve it — if this changes, revisit the docs");
});

test("SKILL.md's primary invocation is the PATH bin, not the credential-less skill file", () => {
  const md = readFileSync(SKILL_MD, "utf8");
  const assignment = md.match(/^LIN=(.*)$/m);
  assert.ok(assignment, "SKILL.md must define the LIN invocation used by its examples");
  const value = assignment[1].split("#")[0].trim();
  assert.equal(value, "linear", `LIN must be the PATH bin; got ${value}`);
  assert.doesNotMatch(
    value,
    /skills\/aios-linear\/linear\.mjs/,
    "the skill file resolves no credential and must not be the primary invocation (AIO-1027)",
  );
});

test("the missing-key error names a command that can actually succeed", () => {
  const core = readFileSync(CORE, "utf8");
  const msg = core.match(/LINEAR_API_KEY not set[^;]*/s)?.[0] ?? "";
  assert.ok(msg, "the missing-key diagnostic must exist");
  assert.doesNotMatch(
    msg,
    /run via:\s*node \.claude\/skills\/aios-linear\/linear\.mjs/,
    "the error must not tell the reader to re-run the exact command that just failed",
  );
  assert.match(msg, /\blinear\b/, "it should point at the bin that resolves the key");
});

test("package.json still exposes the linear bin the docs depend on", () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.bin?.linear, "scripts/linear.mjs", "the documented `linear` bin must exist");
});

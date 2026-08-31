// AIO-1027 regression, updated for AIO-1067: the invocation the docs name must be one that
// RESOLVES the credential.
//
// THE BUG THE ORIGINAL TEST EXISTED FOR: PR #639 documented a Linear entry point that read
// process.env only and resolved nothing, and it passed review because every machine that ran
// it already had LINEAR_API_KEY exported. Post-AIO-1067 there is ONE implementation — the
// built-in adapter behind `aios linear` — and its preflight (ensureLinearCredential) owns
// resolution. The docs must therefore name `aios linear`, and every remaining alternate
// entry point must delegate to that same adapter rather than carrying its own client.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_MD = path.join(ROOT, "scaffold/.claude/skills/aios-linear/SKILL.md");
const SKILL_DELEGATE = path.join(ROOT, "scaffold/.claude/skills/aios-linear/linear.mjs");
const CORE = path.join(ROOT, "scripts/connectors/linear/core.mjs");
const CREDENTIALS = path.join(ROOT, "scripts/connectors/linear/credentials.mjs");
const ADAPTER = path.join(ROOT, "scripts/connectors/linear/index.mjs");
const WRAPPER = path.join(ROOT, "scripts/linear.mjs");

test("the compat bin delegates to the adapter that resolves the credential", () => {
  const wrapper = readFileSync(WRAPPER, "utf8");
  assert.match(wrapper, /loadLinearAdapter/, "scripts/linear.mjs must route to the adapter");
  assert.doesNotMatch(wrapper, /api\.linear\.app/, "the bin must not carry its own client");
  const adapter = readFileSync(ADAPTER, "utf8");
  assert.match(adapter, /ensureLinearCredential/, "the adapter preflights the credential");
  const credentials = readFileSync(CREDENTIALS, "utf8");
  assert.match(
    credentials,
    /resolveConnectorEnv/,
    "the adapter must keep the AIO-790 scoped workspace resolution"
  );
  assert.match(
    credentials,
    /apiKeyEnv: "LINEAR_API_KEY"/,
    "it must resolve LINEAR_API_KEY specifically"
  );
});

test("the provider core still reads only the resolved environment", () => {
  const core = readFileSync(CORE, "utf8");
  assert.match(
    core,
    /process\.env\.LINEAR_API_KEY/,
    "core reads the key the adapter preflight exported"
  );
  assert.doesNotMatch(
    core,
    /resolveConnectorEnv/,
    "core does not resolve credentials — index.mjs owns that seam"
  );
});

test("SKILL.md's primary invocation is the canonical aios route", () => {
  const md = readFileSync(SKILL_MD, "utf8");
  const assignment = md.match(/^LIN=(.*)$/m);
  assert.ok(assignment, "SKILL.md must define the LIN invocation used by its examples");
  const value = assignment[1].split("#")[0].trim();
  assert.equal(value, '"aios linear"', `LIN must be the canonical route; got ${value}`);
  assert.match(md, /aios connect linear/, "the docs must name the credential bootstrap command");
});

test("the skill copies are routing delegates, not a second provider client", () => {
  const delegate = readFileSync(SKILL_DELEGATE, "utf8");
  assert.doesNotMatch(delegate, /api\.linear\.app|LINEAR_API_KEY/);
  assert.match(delegate, /\["linear", \.\.\.process\.argv\.slice\(2\)\]/);
});

test("the missing-key error names a command that can actually succeed", () => {
  const core = readFileSync(CORE, "utf8");
  const msg = core.match(/LINEAR_API_KEY not set[^;]*/s)?.[0] ?? "";
  assert.ok(msg, "the missing-key diagnostic must exist");
  assert.match(msg, /aios connect linear/, "it must point at the bootstrap that resolves the key");
});

test("package.json still exposes the linear bin the compatibility window depends on", () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.bin?.linear, "scripts/linear.mjs", "the compat `linear` bin must exist");
});

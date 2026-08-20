// guard-selftest.test.mjs — pins scripts/guard-selftest.mjs (AIO-953).
//
// The self-test is itself a gate-adjacent surface: humans will trust its verdict
// about whether the write-time secret guard is enforcing. So the one property that
// must never regress is pinned here: when the guard FAILS TO BLOCK a known-secret
// payload (the AIO-945 fail-open defect), the self-test exits non-zero. A self-test
// that goes green over a broken guard would recreate the exact false pass it exists
// to eliminate.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SELFTEST = path.join(ROOT, "scripts", "guard-selftest.mjs");
const REAL_GUARD = path.join(ROOT, "hooks", "team-ops-guard.sh");

function runSelftest(extraArgs = []) {
  const env = { ...process.env };
  delete env.CC_TOOL_INPUT;
  delete env.CC_TOOL_NAME;
  delete env.AIOS_GUARD_ALLOW_UNPARSED;
  return spawnSync(process.execPath, [SELFTEST, ...extraArgs], { encoding: "utf8", env });
}

test("self-test passes against the real guard", () => {
  const r = runSelftest();
  assert.equal(
    r.status,
    0,
    `expected exit 0 against the shipped guard; stdout:\n${r.stdout}\nstderr:\n${r.stderr}`
  );
  assert.match(r.stdout, /guard self-test passed/);
});

test("self-test exits non-zero when the guard fails to block the known-secret case", () => {
  // Neuter a COPY of the guard: same script, but its shared patterns file is replaced
  // with one whose single pattern can never match, so the secret scan is dead. The
  // self-test's secret payload carries valid frontmatter precisely so that no OTHER
  // check (the 2-work/*.md frontmatter gate) can block in the scan's place — with the
  // scan dead the payload genuinely exits 0, which is behaviorally the AIO-945
  // fail-open defect, and the self-test must go red on it. (The patterns file must
  // exist: when it is absent the guard falls back to a built-in pattern list and
  // would still block.)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aios-guard-neutered-"));
  try {
    fs.mkdirSync(path.join(tmp, "hooks"));
    fs.mkdirSync(path.join(tmp, "validation"));
    const neuteredGuard = path.join(tmp, "hooks", "team-ops-guard.sh");
    fs.copyFileSync(REAL_GUARD, neuteredGuard);
    fs.writeFileSync(
      path.join(tmp, "validation", "secret-patterns.txt"),
      "# neutered for the self-test's own test — this pattern never matches\nZZZNEVERMATCHZZZ[0-9]{99}\n"
    );

    const r = runSelftest(["--guard", neuteredGuard]);
    assert.notEqual(
      r.status,
      0,
      `self-test went green over a guard that does not block secrets; stdout:\n${r.stdout}`
    );
    // The failure must be diagnosed as the fail-open path (exit 0), not as some
    // other check blocking in the scan's place.
    assert.match(r.stdout, /DID NOT BLOCK A KNOWN SECRET/);
    assert.match(r.stdout, /exit code: 0 \(expected 2\)/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("self-test fails cleanly when pointed at a missing guard", () => {
  const r = runSelftest(["--guard", "/nonexistent/team-ops-guard.sh"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /guard not found/);
});

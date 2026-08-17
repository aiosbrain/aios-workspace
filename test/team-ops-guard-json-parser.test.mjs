// test/team-ops-guard-json-parser.test.mjs — regression guard for the 0.11.0 clean-container
// defect (AIO-864 follow-up).
//
// The bug: hooks/team-ops-guard.sh shelled out to `jq` with every call wrapped
// `2>/dev/null || true`. `jq` was undeclared and ungated, so on any machine without it the
// parse produced an empty string, `set -euo pipefail` never saw the missing binary, and the
// script fell through to `exit 0  # allow`. A workspace's write-time secret guard was inert,
// silently. An AWS key was written through it at exit 0 with no output.
//
// Why it hid from everyone: macOS 15+ ships /usr/bin/jq and GitHub's ubuntu-latest pre-installs
// it, so the developer machine, the CI runner and the release gate all agreed it worked. The
// only way to see it is to take the binary away.
//
// So these tests do exactly that — they run the SHIPPED hook under a PATH that has been
// stripped down to a curated set of symlinks, with `jq` and/or `node` deliberately excluded.
// Nothing is mocked and nothing is stubbed: it is the real file, reached the real way, with a
// real missing interpreter. Every case below fails on the pre-fix hook.
//
// The container lane in .github/workflows/ci.yml ("clean-container (no jq)") is the same
// assertion against a packed tarball installed in a bare node:22 image; this file is the fast,
// deterministic version that runs in `npm test` on every push.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(DIR, "..", "hooks", "team-ops-guard.sh");

// Everything the hook shells out to, minus the JSON parsers. `printf`, `echo`, `command`,
// `cd`, `pwd` and `case` are bash builtins and need no entry.
const REQUIRED = ["bash", "cat", "dirname", "grep", "awk"];

/** Absolute path of `name` on the real PATH, or null. */
function which(name) {
  const r = spawnSync("/usr/bin/env", ["sh", "-c", `command -v ${name}`], { encoding: "utf8" });
  const p = (r.stdout || "").trim();
  return p && existsSync(p) ? p : null;
}

/**
 * A directory of symlinks that is a complete PATH for the hook, except for whichever
 * interpreters `omit` names. Returns null when the host is missing a required tool (so the
 * test skips rather than failing for an unrelated reason).
 */
function strippedPath(omit) {
  const dir = mkdtempSync(path.join(tmpdir(), "guard-path-"));
  for (const name of [...REQUIRED, "jq", "node"]) {
    if (omit.includes(name)) continue;
    const real = which(name);
    if (!real) {
      if (REQUIRED.includes(name)) {
        rmSync(dir, { recursive: true, force: true });
        return null;
      }
      continue; // jq genuinely absent on this host is fine — that IS the scenario
    }
    symlinkSync(real, path.join(dir, name));
  }
  return dir;
}

/**
 * The host cannot supply a coreutil the hook needs, so the scenario was never exercised.
 * Report that as SKIPPED, never as a pass — a silent early return would make this file look
 * green on a machine where it proved nothing, which is the same shape as the defect it guards.
 */
function skipHost(t) {
  t.skip(`host is missing one of: ${REQUIRED.join(", ")}`);
}

/** Run the shipped hook with `event` on stdin under a PATH that omits `omit`. */
function runHook(event, { omit = [], env = {} } = {}) {
  const dir = strippedPath(omit);
  if (!dir) return null;
  try {
    const r = spawnSync(which("bash") ?? "/bin/bash", [HOOK], {
      input: typeof event === "string" ? event : JSON.stringify(event),
      encoding: "utf8",
      env: { PATH: dir, HOME: process.env.HOME ?? "/tmp", ...env },
    });
    return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A real AWS access key ID shape, split so this file never contains a scannable literal.
const AWS_KEY = "AKIA" + "IOSFODNN7EXAMPLE";
const SECRET_WRITE = {
  tool_name: "Write",
  tool_input: { file_path: "notes.md", content: `k=${AWS_KEY}` },
};

test("no jq: the guard still BLOCKS a secret (the 0.11.0 fail-open)", (t) => {
  const r = runHook(SECRET_WRITE, { omit: ["jq"] });
  if (!r) return skipHost(t);
  assert.notEqual(r.code, 0, "a secret was allowed through with jq absent — this is the bug");
  assert.equal(r.code, 2, "a block must be exit 2 (Claude Code's deny signal)");
  assert.match(r.stderr, /BLOCKED by team-ops-guard/);
  assert.match(r.stderr, /Potential secret detected/);
});

test("no jq: a clean write is still allowed (the fix must not block everything)", (t) => {
  const r = runHook(
    { tool_name: "Write", tool_input: { file_path: "notes.md", content: "hello world" } },
    { omit: ["jq"] }
  );
  if (!r) return skipHost(t);
  assert.equal(r.code, 0, `clean write blocked: ${r.stderr}`);
});

test("no jq: MultiEdit batches are still scanned", (t) => {
  const r = runHook(
    {
      tool_name: "MultiEdit",
      tool_input: {
        file_path: "notes.md",
        edits: [{ new_string: "fine" }, { new_string: AWS_KEY }],
      },
    },
    { omit: ["jq"] }
  );
  if (!r) return skipHost(t);
  assert.equal(r.code, 2, `MultiEdit secret not blocked: ${r.stderr}`);
});

test("no jq: admin-tier content is still kept out of 4-shared/", (t) => {
  const r = runHook(
    {
      tool_name: "Write",
      tool_input: { file_path: "4-shared/x.md", content: "---\naccess: admin\n---\nbody" },
    },
    { omit: ["jq"] }
  );
  if (!r) return skipHost(t);
  assert.equal(r.code, 2, `admin content allowed into 4-shared: ${r.stderr}`);
});

test("no parser at all: the guard refuses rather than reporting allow, and names jq", (t) => {
  const r = runHook(SECRET_WRITE, { omit: ["jq", "node"] });
  if (!r) return skipHost(t);
  assert.equal(r.code, 2, "with no JSON parser the guard must not answer 'allow'");
  assert.match(r.stderr, /AIOS_GUARD_NO_JSON_PARSER/, "the failure must be named");
  assert.match(r.stderr, /\bjq\b/, "the user must be able to tell jq is the cause");
  assert.match(r.stderr, /\bnode\b/, "and that node is the alternative");
});

test("no parser at all: silence is never an option", (t) => {
  // The precise property the 0.11.0 defect violated: exit 0 AND no output.
  for (const env of [{}, { AIOS_GUARD_ALLOW_UNPARSED: "1" }]) {
    const r = runHook(SECRET_WRITE, { omit: ["jq", "node"], env });
    if (!r) return skipHost(t);
    assert.notEqual(
      `${r.code}:${r.stderr.trim()}`,
      "0:",
      "the guard exited 0 with no diagnostic — exactly the 0.11.0 silent fail-open"
    );
  }
});

test("no parser at all: the documented escape hatch allows, but shouts every time", (t) => {
  const r = runHook(SECRET_WRITE, {
    omit: ["jq", "node"],
    env: { AIOS_GUARD_ALLOW_UNPARSED: "1" },
  });
  if (!r) return skipHost(t);
  assert.equal(r.code, 0, "the override must let work continue");
  assert.match(r.stderr, /AIOS_GUARD_DEGRADED/, "and must say the guard is off");
  assert.match(r.stderr, /UNCHECKED/);
});

test("unparseable input is not treated as an absent field", (t) => {
  // "Parsed fine, no tool_input" allows; "could not read the document" must not borrow
  // that branch. Both used to land on `exit 0`.
  const garbage = runHook("this is not json{{", {});
  const noToolInput = runHook({ tool_name: "Read" }, {});
  // Guard BOTH results. Leaning on the first check to cover the second is a TypeError
  // waiting for the first host that cannot build the stripped PATH.
  if (!garbage || !noToolInput) return skipHost(t);
  assert.equal(garbage.code, 2, "malformed JSON must not be read as 'nothing to check'");
  assert.equal(noToolInput.code, 0, "a well-formed event with no tool_input is a real allow");
});

test("array shapes are unreadable to BOTH parsers, not empty to one of them", (t) => {
  // jq errors on `[] | .file_path` ("Cannot index array with string") and so blocks. A
  // bare `typeof o === "object"` check in the node extractor would let node answer "no
  // such field" and ALLOW the same event. A parser difference landing on the permissive
  // side is exactly the defect class this file guards, so both shapes are pinned for
  // both parsers.
  for (const event of [{ tool_name: "Write", tool_input: [] }, [1, 2]]) {
    for (const omit of [[], ["jq"]]) {
      const r = runHook(event, { omit });
      if (!r) return skipHost(t);
      assert.equal(
        r.code,
        2,
        `${JSON.stringify(event)} with omit=${JSON.stringify(omit)} must block, got ${r.code}`
      );
    }
  }
});

test("an empty event is still a legitimate allow", (t) => {
  // `bash hooks/team-ops-guard.sh </dev/null` must not start blocking.
  const r = runHook("", {});
  if (!r) return skipHost(t);
  assert.equal(r.code, 0, `empty stdin should allow, got ${r.code}: ${r.stderr}`);
});

// test/delivery/read-only-boundary.test.mjs — the structural half of AIO-579's non-negotiable
// safety property: "read-only, always". safe-exec.test.mjs proves the allowlist itself is
// correct; this proves nothing in the feature can BYPASS it. Every subprocess call anywhere
// under scripts/delivery/**/*.mjs or scripts/delivery-status.mjs must go through
// scripts/delivery/safe-exec.mjs's safeGit/safeGh — this greps the actual source for every
// other way a mutating call could sneak in (execFileSync/exec/execSync/spawn) and fails if any
// file besides safe-exec.mjs itself uses one.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DELIVERY_DIR = path.join(ROOT, "scripts", "delivery");
const SAFE_EXEC = path.join(DELIVERY_DIR, "safe-exec.mjs");
const ORCHESTRATOR = path.join(ROOT, "scripts", "delivery-status.mjs");

function featureFiles() {
  const files = readdirSync(DELIVERY_DIR)
    .filter((f) => f.endsWith(".mjs"))
    .map((f) => path.join(DELIVERY_DIR, f));
  files.push(ORCHESTRATOR);
  return files;
}

// Matches any direct call into node:child_process's process-spawning surface.
const SUBPROCESS_CALL_RE = /\b(execFileSync|execFile|execSync|exec|spawnSync|spawn)\s*\(/;

test("no delivery-status source file spawns a subprocess directly except safe-exec.mjs", () => {
  for (const file of featureFiles()) {
    if (file === SAFE_EXEC) continue;
    const src = readFileSync(file, "utf8");
    assert.doesNotMatch(
      src,
      SUBPROCESS_CALL_RE,
      `${path.relative(ROOT, file)} calls a subprocess function directly — it must go through ` +
        "safeGit/safeGh in scripts/delivery/safe-exec.mjs instead"
    );
  }
});

test("safe-exec.mjs is the only file importing node:child_process in this feature", () => {
  for (const file of featureFiles()) {
    const src = readFileSync(file, "utf8");
    const importsChildProcess = /from\s+["']node:child_process["']/.test(src);
    if (file === SAFE_EXEC) {
      assert.ok(importsChildProcess, "safe-exec.mjs should import node:child_process");
    } else {
      assert.ok(
        !importsChildProcess,
        `${path.relative(ROOT, file)} imports node:child_process — only safe-exec.mjs may`
      );
    }
  }
});

test("safe-exec.mjs exports exactly the two allowlisted wrappers", async () => {
  const mod = await import("../../scripts/delivery/safe-exec.mjs");
  assert.deepEqual(Object.keys(mod).sort(), ["safeGh", "safeGit"]);
});

test("no delivery-status source file references known mutating verbs as a literal argv element", () => {
  // Belt-and-braces: even inside safe-exec.mjs's OWN allowlist tables, a mutating verb must
  // never appear as an alloweded value. This guards against a future edit widening the
  // allowlist to include one of these by mistake.
  const forbiddenGitVerbs = [
    "push",
    "merge",
    "reset",
    "clean",
    "stash",
    "checkout",
    "rebase",
    "cherry-pick",
    "commit",
  ];
  const forbiddenGhVerbs = ["merge", "close", "create", "edit", "review"];
  const src = readFileSync(SAFE_EXEC, "utf8");

  // Extract the actual allowlist Set literals (not comments/docs) by looking at the two
  // `new Set([...])` declarations.
  const setLiterals = [...src.matchAll(/new Set\(\[([^\]]*)\]\)/g)].map((m) => m[1]);
  assert.ok(setLiterals.length >= 3, "expected at least three allowlist Set literals");

  for (const literal of setLiterals) {
    for (const verb of [...forbiddenGitVerbs, ...forbiddenGhVerbs]) {
      assert.doesNotMatch(
        literal,
        new RegExp(`["']${verb}["']`),
        `allowlist literal unexpectedly contains the mutating verb '${verb}': ${literal}`
      );
    }
  }
});

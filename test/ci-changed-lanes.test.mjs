/**
 * AIO-599 — lane classification for path-filtered CI.
 *
 * The asymmetry under test: a wrong `true` costs a runner minute, a wrong `false`
 * lets an untested change reach main. Every ambiguous input must produce `true`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { classifyChangedPaths, isInert, allLanes, LANES } from "../scripts/ci-changed-lanes.mjs";

const SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "ci-changed-lanes.mjs"
);

test("T1: a docs-only diff switches every filterable lane off", () => {
  const lanes = classifyChangedPaths(["docs/brain-api.md", "README.md", "LICENSE"]);
  assert.deepEqual(lanes, { code: false, rust: false, client: false });
});

test("T2: one non-inert path anywhere in the diff turns code back on", () => {
  const lanes = classifyChangedPaths(["docs/architecture.md", "scripts/aios.mjs"]);
  assert.equal(lanes.code, true);
});

test("T3: scaffold markdown is shipped product, not inert docs", () => {
  assert.equal(isInert("scaffold/.claude/rules/frontmatter.md"), false);
  assert.equal(classifyChangedPaths(["scaffold/CLAUDE.md.tmpl"]).code, true);
});

test("T4: only root-level markdown is inert; nested markdown is not", () => {
  assert.equal(isInert("CLAUDE.md"), true);
  assert.equal(isInert("gui/client/README.md"), false);
});

test("T5: the docs/ prefix is anchored — a sibling directory is not inert", () => {
  assert.equal(isInert("docs-site/index.md"), false);
  assert.equal(isInert("examples/docs/thing.md"), false);
});

test("T6: src-tauri changes enable rust only", () => {
  const lanes = classifyChangedPaths(["src-tauri/src/main.rs"]);
  assert.deepEqual(lanes, { code: true, rust: true, client: false });
});

test("T7: gui changes enable client only", () => {
  const lanes = classifyChangedPaths(["gui/client/src/App.tsx"]);
  assert.deepEqual(lanes, { code: true, rust: false, client: true });
});

test("T8: the rust lane also watches its own runner script", () => {
  assert.equal(classifyChangedPaths(["scripts/run-rust-tests.mjs"]).rust, true);
});

test("T9: shared build inputs enable every lane", () => {
  for (const shared of ["package.json", "package-lock.json", ".github/workflows/ci.yml"]) {
    assert.deepEqual(
      classifyChangedPaths([shared]),
      allLanes(),
      `${shared} must enable every lane`
    );
  }
});

test("T10: a scripts-only change keeps code on but leaves rust and client off", () => {
  const lanes = classifyChangedPaths(["scripts/check-boundaries.mjs", "test/thing.test.mjs"]);
  assert.deepEqual(lanes, { code: true, rust: false, client: false });
});

test("T11: every ambiguous input fails OPEN", () => {
  for (const input of [null, undefined, [], [""], ["   "], "scripts/aios.mjs", 42, {}]) {
    assert.deepEqual(
      classifyChangedPaths(input),
      allLanes(),
      `${JSON.stringify(input)} must enable every lane`
    );
  }
});

test("T12: whitespace around a path does not hide it from a lane", () => {
  assert.equal(classifyChangedPaths(["  src-tauri/Cargo.toml  "]).rust, true);
});

test("T13: the CLI writes every lane to GITHUB_OUTPUT", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aios-lanes-"));
  const paths = path.join(dir, "changed.txt");
  const out = path.join(dir, "gh-output");
  fs.writeFileSync(paths, "gui/client/src/App.tsx\n");
  fs.writeFileSync(out, "");

  execFileSync(process.execPath, [SCRIPT, "--paths-from", paths], {
    env: { ...process.env, GITHUB_OUTPUT: out },
    stdio: "pipe",
  });

  const written = fs.readFileSync(out, "utf8");
  for (const lane of LANES) {
    assert.match(written, new RegExp(`^${lane}=(true|false)$`, "m"), `${lane} must be written`);
  }
  assert.match(written, /^client=true$/m);
  assert.match(written, /^rust=false$/m);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("T15: the direct-run guard still fires when the path needs URL escaping", () => {
  // `import.meta.url === `file://${process.argv[1]}`` compares an ENCODED url against an
  // UNENCODED path, so a single space in the checkout path stops main() from running and no
  // lane values are written at all. Node absolutizes argv[1], so this is the only way the
  // guard actually breaks — and it breaks toward "skip everything".
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aios lanes ")); // space is the point
  const script = path.join(dir, "ci-changed-lanes.mjs");
  const out = path.join(dir, "gh-output");
  const paths = path.join(dir, "changed.txt");
  fs.copyFileSync(SCRIPT, script);
  fs.writeFileSync(paths, "src-tauri/src/main.rs\n");
  fs.writeFileSync(out, "");

  execFileSync(process.execPath, [script, "--paths-from", paths], {
    env: { ...process.env, GITHUB_OUTPUT: out },
    stdio: "pipe",
  });

  const written = fs.readFileSync(out, "utf8");
  assert.notEqual(written.trim(), "", "main() must run from a path containing a space");
  assert.match(written, /^rust=true$/m);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("T14: a missing changed-path file makes the CLI emit every lane on", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aios-lanes-"));
  const out = path.join(dir, "gh-output");
  fs.writeFileSync(out, "");

  execFileSync(process.execPath, [SCRIPT, "--paths-from", path.join(dir, "absent.txt")], {
    env: { ...process.env, GITHUB_OUTPUT: out },
    stdio: "pipe",
  });

  const written = fs.readFileSync(out, "utf8");
  for (const lane of LANES) {
    assert.match(written, new RegExp(`^${lane}=true$`, "m"), `${lane} must fail open`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

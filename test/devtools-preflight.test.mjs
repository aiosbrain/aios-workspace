/**
 * The devtools migration preflight (AIO-665; scripts/devtools-preflight.mjs).
 *
 * The load-bearing test here is the FALSE-PASS one. The first version of this preflight reported
 * ✓ for all five dispatch targets with the package uninstalled, because
 * `resolveDevtoolsModule()` only BUILDS a specifier string — for the package branch it returns
 * "@aiosbrain/aios-devtools/ship" without checking anything exists. A preflight that cannot
 * detect the exact condition it was written to detect is worse than no preflight, so that case
 * is pinned first.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  checkDevtools,
  declaredDevtoolsRange,
  devtoolsPackageVersion,
  formatDevtoolsReport,
  isExactDevtoolsVersion,
} from "../scripts/devtools-preflight.mjs";

/** A `require` stand-in whose `resolve` fails, i.e. the package is not installed. */
const missingReq = Object.assign(
  () => {
    throw new Error("Cannot find package");
  },
  {
    resolve() {
      throw new Error("Cannot find package '@aiosbrain/aios-devtools'");
    },
  }
);

/** A `require` stand-in where everything resolves. */
const presentReq = Object.assign(() => ({ version: "0.2.0" }), { resolve: (s) => `/fake/${s}` });

function bareTree() {
  const dir = mkdtempSync(path.join(tmpdir(), "devtools-preflight-"));
  mkdirSync(path.join(dir, "scripts"), { recursive: true });
  return dir;
}

test("an uninstalled package FAILS the preflight — the false pass that shipped first", () => {
  const core = bareTree();
  try {
    const report = checkDevtools({
      coreScripts: path.join(core, "scripts"),
      argv: [],
      env: {},
      req: missingReq,
      pkg: { dependencies: { "@aiosbrain/aios-devtools": "0.2.0" } },
    });
    assert.equal(report.ok, false, "must not report ok when nothing resolves");
    assert.equal(report.modules.length, 5);
    for (const m of report.modules) {
      assert.equal(m.ok, false, `${m.name} must be reported as unresolvable`);
      assert.match(m.error, /is not installed/);
    }
  } finally {
    rmSync(core, { recursive: true, force: true });
  }
});

test("an installed package passes, and every dispatch target is accounted for", () => {
  const core = bareTree();
  try {
    const report = checkDevtools({
      coreScripts: path.join(core, "scripts"),
      argv: [],
      env: {},
      req: presentReq,
      pkg: { dependencies: { "@aiosbrain/aios-devtools": "0.2.0" } },
    });
    assert.equal(report.ok, true);
    assert.deepEqual(report.modules.map((m) => m.name).sort(), [
      "build",
      "consolidate-findings",
      "roadmap-run",
      "ship",
      "spec-eval",
    ]);
  } finally {
    rmSync(core, { recursive: true, force: true });
  }
});

test("an adjacent checkout is reported as the live source, not the package", () => {
  // The contributor flow: AIOS_DEVTOOLS_DIR wins, and the report must SAY so — "it works" is
  // not the same answer as "it works, from your local checkout rather than the pinned release".
  const core = bareTree();
  const checkout = bareTree();
  try {
    for (const n of ["ship", "build", "roadmap-run", "spec-eval", "consolidate-findings"]) {
      writeFileSync(path.join(checkout, "scripts", `${n}.mjs`), "export const x = 1;\n");
    }
    const report = checkDevtools({
      coreScripts: path.join(core, "scripts"),
      argv: [],
      env: { AIOS_DEVTOOLS_DIR: checkout },
      req: missingReq, // the package is NOT installed; the checkout must carry it
      pkg: { dependencies: {} },
    });
    assert.equal(report.ok, true, "an adjacent checkout satisfies the preflight on its own");
    for (const m of report.modules) assert.equal(m.source, "AIOS_DEVTOOLS_DIR");
  } finally {
    rmSync(core, { recursive: true, force: true });
    rmSync(checkout, { recursive: true, force: true });
  }
});

test("every semver range, wildcard, tag, and non-registry spec is rejected as unpinned", () => {
  // AIO-665 asks for a pinned distribution. A caret range means a fresh install can differ from
  // the one that was verified, which is the whole point of pinning — so the report says it.
  const core = bareTree();
  try {
    for (const declared of [
      "^0.2.0",
      "~0.2.0",
      ">=0.2.0",
      "0.2.x",
      "0.x",
      "*",
      "0.2",
      "0.2.0 || 0.3.0",
      "latest",
      "workspace:0.2.0",
      "file:../aios-devtools",
    ]) {
      assert.equal(isExactDevtoolsVersion(declared), false, `${declared} must not count as a pin`);
      const report = checkDevtools({
        coreScripts: path.join(core, "scripts"),
        argv: [],
        env: {},
        req: presentReq,
        pkg: { dependencies: { "@aiosbrain/aios-devtools": declared } },
      });
      assert.equal(report.ok, false, `${declared} must fail the preflight`);
      assert.match(formatDevtoolsReport(report).join("\n"), /is not an EXACT VERSION/);
    }
  } finally {
    rmSync(core, { recursive: true, force: true });
  }

  for (const exact of ["0.2.0", "1.2.3-beta.1", "1.2.3+build.7"]) {
    assert.equal(isExactDevtoolsVersion(exact), true, `${exact} must count as an exact pin`);
  }
});

test("a failing report carries install, checkout AND rollback instructions", () => {
  const out = formatDevtoolsReport({
    ok: false,
    declared: "0.2.0",
    installed: null,
    modules: [{ name: "ship", ok: false, error: "nope" }],
  }).join("\n");
  assert.match(out, /npm i @aiosbrain\/aios-devtools/);
  assert.match(out, /AIOS_DEVTOOLS_DIR/);
  assert.match(out, /Rollback:.*@aiosbrain\/aios@0\.9\.1/);
});

test("this repo declares devtools as an exact pin", () => {
  // Guards the AIO-665 decision itself: if someone loosens it back to a range, the preflight's
  // own advisory would start firing on every run, which is a signal, not a fix.
  const declared = declaredDevtoolsRange();
  assert.ok(declared, "@aiosbrain/aios-devtools must be a declared dependency");
  assert.ok(isExactDevtoolsVersion(declared), `expected an exact pin, got '${declared}'`);
});

test("the installed version is readable, or null — never a throw", () => {
  assert.equal(devtoolsPackageVersion({ req: missingReq }), null);
  assert.equal(devtoolsPackageVersion({ req: presentReq }), "0.2.0");
});

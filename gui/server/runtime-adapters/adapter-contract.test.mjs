// adapter-contract.test.mjs — gui/server's side of the adapter-registry contract (AIO-600 C5).
//
// The contract itself is CORE-OWNED (@aiosbrain/foundation/adapter-contract): core's OGR07
// (validation/check-runtime-adapters.mjs) runs the same checks against this registry while both
// live in one tree (skip-when-absent), and THIS test keeps enforcing them from the gui side after
// the repo cut — it imports only gui modules + the published @aiosbrain/foundation package.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";

// Relative paths in-tree (worktrees symlink node_modules from the primary checkout, so
// just-added package subpaths don't resolve there); these become the published
// `@aiosbrain/foundation/{adapter-contract,runtimes}` specifiers at cut time.
import {
  checkAdapterRegistry,
  checkGuardWrite,
} from "../../../packages/foundation/src/adapter-contract.mjs";
import { RUNTIMES, GUI_RUNTIMES } from "../../../packages/foundation/src/runtimes.mjs";
import * as registry from "./index.mjs";
import { guardWrite } from "./guard.mjs";
import { locateToolkit } from "../toolkit-locate.mjs";

test("adapter registry satisfies the core-owned adapter-registry contract", () => {
  assert.deepEqual(checkAdapterRegistry(registry, { RUNTIMES, GUI_RUNTIMES }), []);
});

test("guardWrite satisfies the guard contract (team-ops-guard.sh governance)", (t) => {
  // The guard shells out to <toolkit>/hooks/team-ops-guard.sh (single governance source) and
  // needs jq + bash. Skip — don't fail — when the toolkit or the hook can't be located, same
  // posture as OGR07's transitional check.
  let toolkit;
  try {
    toolkit = locateToolkit();
  } catch (e) {
    return t.skip(`toolkit not locatable: ${e.message}`);
  }
  if (!existsSync(path.join(toolkit.dir, "hooks", "team-ops-guard.sh"))) {
    return t.skip("toolkit has no hooks/team-ops-guard.sh");
  }
  try {
    assert.deepEqual(checkGuardWrite(guardWrite, toolkit.dir), []);
  } catch (e) {
    if (e instanceof assert.AssertionError) throw e;
    t.skip(`guardWrite not runnable here: ${e.message}`);
  }
});

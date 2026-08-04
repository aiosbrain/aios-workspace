import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { cmdUpdate } from "../scripts/update.mjs";
import { git, originAndToolkitClone } from "./toolkit-test-fixtures.mjs";

test("an exact release-tag checkout can only be applied through the explicit --no-pull path", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-release-tag-"));
  try {
    const { clone } = originAndToolkitClone(root);
    git(clone, "tag", "v1.0.0");
    git(clone, "checkout", "-q", "--detach", "v1.0.0");

    const workspace = path.join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(workspace, "aios.yaml"), "owner: t\n");

    const refused = await cmdUpdate(workspace, {}, ["--check", "--from", clone]);
    assert.equal(refused.applyAllowed, false, "a normal update refuses detached HEAD");
    assert.match(refused.reasons.join("\n"), /detached HEAD/);

    const preview = await cmdUpdate(workspace, {}, ["--preview", "--from", clone]);
    assert.equal(preview.mode, "preview", "preview is read-only and accepts the tagged source");
    assert.ok(preview.srcHead, "preview reports the exact release commit");

    const apply = await cmdUpdate(workspace, {}, [
      "--no-pull",
      "--from",
      clone,
      "--expect-src-head",
      preview.srcHead,
    ]);
    assert.equal(apply.exitStatus, 0, "the explicit pinned release is applied successfully");
    assert.equal(apply.srcHead, preview.srcHead, "apply uses exactly the previewed release commit");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// test/instincts-distill-live.test.mjs — the ONE test that spends a real claude -p call.
// Double-gated on INSTINCTS_LIVE=1 AND claude CLI availability (not ANTHROPIC_API_KEY alone:
// direnv exports keys globally and would silently spend on every `npm test`).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SCHEMA_VERSION, OBS_STORE_REL } from "../scripts/analyze/maturity-store.mjs";
import { personalInstinctsDir, resolveProjectId } from "../scripts/instincts.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "scripts", "aios.mjs");

function claudeAvailable() {
  try {
    execFileSync("claude", ["--version"], { encoding: "utf8", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

const LIVE = process.env.INSTINCTS_LIVE === "1" && claudeAvailable();

test(
  "live distill produces an instinct file from synthetic observations",
  { skip: LIVE ? false : "set INSTINCTS_LIVE=1 and install `claude` CLI to run" },
  async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "instincts-live-"));
    const homunculus = mkdtempSync(path.join(tmpdir(), "homunculus-live-"));
    const obs = {
      id: "live-obs-1",
      session_id: "live-sess",
      ts: "2026-07-03T16:00:00.000Z",
      kind: "correction",
      snippet: "no - use the existing helper in scripts/flat-yaml.mjs",
      prior_hash: "live-prior-hash",
      tier: "admin",
      createdAt: "2026-07-03T16:00:00.000Z",
    };
    const store = path.join(dir, OBS_STORE_REL);
    mkdirSync(path.dirname(store), { recursive: true });
    writeFileSync(store, JSON.stringify({ v: SCHEMA_VERSION, op: "create", obs }) + "\n");

    execFileSync("node", [CLI, "instincts", "distill", "--repo", dir, "--json"], {
      env: { ...process.env, AIOS_HOMUNCULUS_DIR: homunculus },
      encoding: "utf8",
      timeout: 180_000,
    });

    const projectId = resolveProjectId(dir);
    const outDir = personalInstinctsDir(homunculus, projectId);
    const files = readdirSync(outDir).filter((f) => f.endsWith(".md"));
    assert.ok(files.length >= 1);
    const body = readFileSync(path.join(outDir, files[0]), "utf8");
    assert.match(body, /^---\n/);
    assert.match(body, /trigger:/);
    assert.match(body, /origin_obs:.*live-obs-1/);
    rmSync(dir, { recursive: true, force: true });
    rmSync(homunculus, { recursive: true, force: true });
  }
);

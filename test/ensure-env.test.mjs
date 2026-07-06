// scripts/ensure-env.mjs — guarantees a workspace has a .env before anything that shells
// out to dotenvx runs against it (dotenvx's `run --` refuses to start at all if .env is
// missing, even before any real secret is ever set — the MISSING_ENV_FILE crash a
// scaffold-then-immediately-run-gui flow used to hit).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureEnv } from "../scripts/ensure-env.mjs";

function ws() {
  return mkdtempSync(path.join(tmpdir(), "ensure-env-"));
}

test("copies .env.example to .env when .env is missing", () => {
  const dir = ws();
  writeFileSync(path.join(dir, ".env.example"), "AIOS_API_KEY=\nAIOS_MEMBER=\n");

  const created = ensureEnv(dir);

  assert.equal(created, true);
  assert.equal(existsSync(path.join(dir, ".env")), true);
  assert.equal(readFileSync(path.join(dir, ".env"), "utf8"), "AIOS_API_KEY=\nAIOS_MEMBER=\n");
});

test("creates an empty .env when there is no .env.example either", () => {
  const dir = ws();

  const created = ensureEnv(dir);

  assert.equal(created, true);
  assert.equal(readFileSync(path.join(dir, ".env"), "utf8"), "");
});

test("never overwrites an existing .env, even if .env.example is present", () => {
  const dir = ws();
  writeFileSync(path.join(dir, ".env.example"), "AIOS_API_KEY=\n");
  writeFileSync(path.join(dir, ".env"), "AIOS_API_KEY=already-a-real-key\n");

  const created = ensureEnv(dir);

  assert.equal(created, false);
  assert.equal(readFileSync(path.join(dir, ".env"), "utf8"), "AIOS_API_KEY=already-a-real-key\n");
});

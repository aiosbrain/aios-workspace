// AIO-790 — Linear must not decrypt the whole toolkit .env.
// Mixed ciphertext (LINEAR readable, OPENAI not) makes `dotenvx run -f .env` emit
// WRONG_PRIVATE_KEY. scripts/linear.mjs decrypts only LINEAR_API_KEY and stays quiet.
// Fixtures are synthetic dotenvx ciphertext; they are not production secrets.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decryptDotenvKey } from "../scripts/brain-config.mjs";
import { assertSecretEqual, scrubAmbientProcessEnv } from "./helpers/scrubbed-env.mjs";

// AIO-1028: an ambient OPENAI_API_KEY (the Tessera cascade exports a real one) means
// `dotenvx run` never needs to decrypt the sibling ciphertext below, so the
// WRONG_PRIVATE_KEY warning the first test asserts on doesn't fire. Scrub the ambient
// environment so the mixed-key fixture behaves the same on every machine.
scrubAmbientProcessEnv();

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOTENVX_BIN = path.join(ROOT, "node_modules", ".bin", "dotenvx");
const WRAPPER = path.join(ROOT, "scripts/linear.mjs");
const LIN_SECRET = "lin-test-not-a-real-secret";
const OAI_SECRET = "oai-test-not-a-real-secret";

function strippedEnv() {
  const env = { ...process.env };
  delete env.DOTENV_PUBLIC_KEY;
  delete env.DOTENV_PRIVATE_KEY;
  delete env.LINEAR_API_KEY;
  return env;
}

function dotenvxSet(repo, key, value) {
  execFileSync(DOTENVX_BIN, ["set", key, value, "-f", path.join(repo, ".env")], {
    cwd: repo,
    env: strippedEnv(),
    stdio: ["ignore", "ignore", "pipe"],
  });
}

function makeMixedRepo() {
  const repo = mkdtempSync(path.join(tmpdir(), "aio790-lin-"));
  writeFileSync(path.join(repo, ".env"), "");
  dotenvxSet(repo, "LINEAR_API_KEY", LIN_SECRET);
  // Sibling ciphertext the current keypair cannot read. Same shape as aios-workspace/.env
  // (LINEAR decrypts; OPENAI does not). Do not use a second real keypair — that breaks
  // `dotenvx get LINEAR_API_KEY` on dotenvx 2.x.
  writeFileSync(
    path.join(repo, ".env"),
    `${readFileSync(path.join(repo, ".env"), "utf8").trimEnd()}\nOPENAI_API_KEY=encrypted:BNotARealCiphertextForAIO790==\n`
  );
  return repo;
}

test("dotenvx run on a mixed-key .env warns about the unrelated secret", () => {
  const repo = makeMixedRepo();
  try {
    const result = spawnSync(
      DOTENVX_BIN,
      ["run", "--quiet", "-f", ".env", "--", process.execPath, "-e", "process.exit(0)"],
      { cwd: repo, env: strippedEnv(), encoding: "utf8" }
    );
    const combined = `${result.stdout}\n${result.stderr}`;
    assert.match(result.stderr, /WRONG_PRIVATE_KEY|DECRYPTION_FAILED/);
    assert.match(result.stderr, /OPENAI_API_KEY/);
    assert.doesNotMatch(combined, new RegExp(LIN_SECRET));
    assert.doesNotMatch(combined, new RegExp(OAI_SECRET));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("scoped Linear wrapper decrypts LINEAR_API_KEY without WRONG_PRIVATE_KEY noise", () => {
  const repo = makeMixedRepo();
  try {
    assertSecretEqual(decryptDotenvKey(repo, "LINEAR_API_KEY"), LIN_SECRET, "scoped decrypt");

    const result = spawnSync(process.execPath, [WRAPPER, "template", "aios"], {
      cwd: repo,
      env: strippedEnv(),
      encoding: "utf8",
    });
    const combined = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /What \/ why/);
    // AIO-1067: the bin is a warning-only delegate — exactly one deprecation line on
    // stderr, and still zero dotenvx key-mismatch noise (the AIO-790 property).
    assert.match(result.stderr, /deprecated compatibility command/);
    assert.doesNotMatch(result.stderr, /WRONG_PRIVATE_KEY|DECRYPTION_FAILED/);
    assert.doesNotMatch(combined, new RegExp(LIN_SECRET));
    assert.doesNotMatch(combined, new RegExp(OAI_SECRET));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("aios-linear skill copies stay byte-identical and do not recommend dotenvx run for Linear", () => {
  // Every file in either copy, discovered rather than hard-coded: a file added to one copy
  // but not listed here (the AIO-907/914 drift) must fail this test, not slip past it.
  const managedDir = path.join(ROOT, ".claude/skills/aios-linear");
  const scaffoldDir = path.join(ROOT, "scaffold/.claude/skills/aios-linear");
  const files = [...new Set([...readdirSync(managedDir), ...readdirSync(scaffoldDir)])].sort();
  assert.ok(files.includes("SKILL.md"), "sanity: skill directory listing looks wrong");
  // AIO-1072: the skill dirs are routing documentation only — no executable delegate.
  assert.ok(!files.includes("linear.mjs"), "the retired linear.mjs delegate must stay deleted");
  for (const name of files) {
    let managed, scaffold;
    try {
      managed = readFileSync(path.join(managedDir, name));
      scaffold = readFileSync(path.join(scaffoldDir, name));
    } catch {
      assert.fail(`${name} exists in only one skill copy`);
    }
    assert.equal(managed.equals(scaffold), true, `${name} copies diverged`);
  }
  const skill = readFileSync(path.join(ROOT, ".claude/skills/aios-linear/SKILL.md"), "utf8");
  assert.match(skill, /scripts\/linear\.mjs/);
  assert.doesNotMatch(
    skill,
    /dotenvx run --quiet -f \$AIOS_WS\/\.env -- node \$AIOS_WS\/\.claude\/skills\/aios-linear\/linear\.mjs/
  );
  assert.doesNotMatch(
    skill,
    /LIN="dotenvx run --quiet -f \.env -- node \.claude\/skills\/aios-linear\/linear\.mjs"/
  );
});

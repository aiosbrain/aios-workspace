// AIO-952: OGR03 must catch provider-shaped credential VALUES regardless of the
// identifier they are bound to. aios-team-brain PR #575 demonstrated the bypass:
// renaming `TOKEN` -> `FIXTURE_PK` (same ClickUp-shaped value) flipped the gate
// from CRITICAL to PASSED, because the generic rules key on the binding name and
// no value rule covered the `pk_` prefix.
//
// Every secret-shaped value below is assembled by concatenation so this test file
// never contains a contiguous credential-shaped literal (OGR03 scans this repo).
// Values are synthetic and deliberately marker-free: the AIO-965 sanitizer strips
// tokens containing SENTINEL/EXAMPLE/FAKE/etc, so marker-bearing values would not
// exercise the scanner at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCANNER = path.join(ROOT, "validation", "check-secrets.sh");

const CLICKUP_VALUE = "pk_" + "9q7x" + "w3jm4vbt2rkd8ncz5qhy6fw2";
const LINEAR_VALUE = "lin_" + "api_" + "h4vt8r2jm9qw6zkd3ncy5bXe7g";
const GITHUB_OAUTH_VALUE = "gho_" + "Zr8k" + "Tq2Wm9Xv4Jn7Hb3Pd6Fs1Lg5Yc0Aq8Uw2Ei";

function repoWith(filename, content) {
  const dir = mkdtempSync(path.join(tmpdir(), "aio952-secrets-"));
  execFileSync("git", ["-C", dir, "init", "-q"]);
  writeFileSync(path.join(dir, filename), content);
  execFileSync("git", ["-C", dir, "add", filename]);
  return dir;
}

function scan(dir) {
  return spawnSync("bash", [SCANNER, dir], { encoding: "utf8" });
}

function scanLines(filename, lines) {
  const dir = repoWith(filename, `${lines.join("\n")}\n`);
  try {
    return scan(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("OGR03 flags provider-shaped values bound to innocent identifier names", () => {
  const result = scanLines("integration.mjs", [
    `const clickupProjectRef = "${CLICKUP_VALUE}";`,
    `const workspaceRef = "${LINEAR_VALUE}";`,
    `const ciRef = "${GITHUB_OAUTH_VALUE}";`,
  ]);
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 1, output);
  assert.match(output, /OGR03 FAILED/);
  assert.match(output, /line 1: \[REDACTED\]/);
  assert.match(output, /line 2: \[REDACTED\]/);
  assert.match(output, /line 3: \[REDACTED\]/);
  for (const value of [CLICKUP_VALUE, LINEAR_VALUE, GITHUB_OAUTH_VALUE]) {
    assert.ok(!output.includes(value), "diagnostics must not echo the candidate secret");
  }
});

test("OGR03: renaming a binding no longer flips CRITICAL to PASS (the PR #575 bypass)", () => {
  // Same value under both names; the scan must fail either way.
  const named = scanLines("named.mjs", [`const token = "${CLICKUP_VALUE}";`]);
  assert.equal(named.status, 1, `${named.stdout}${named.stderr}`);

  const renamed = scanLines("renamed.mjs", [`const clickupFixtureRef = "${CLICKUP_VALUE}";`]);
  assert.equal(renamed.status, 1, `${renamed.stdout}${renamed.stderr}`);
});

test("OGR03 accepts a secret-shaped value on a line declared as a fixture", () => {
  const result = scanLines("fixture.mjs", [
    `const clickupToken = "${CLICKUP_VALUE}"; // aios-secret-fixture: synthetic ClickUp shape for scanner tests`,
  ]);
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 0, output);
  assert.match(output, /OGR03 PASSED/);
});

test("OGR03: a fixture declaration silences only its own line", () => {
  const result = scanLines("mixed.mjs", [
    `const declared = "${CLICKUP_VALUE}"; // aios-secret-fixture: synthetic shape under test`,
    `const undeclared = "${LINEAR_VALUE}";`,
  ]);
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 1, output);
  assert.match(output, /line 2: \[REDACTED\]/);
  assert.ok(!/line 1: \[REDACTED\]/.test(output), "declared line must not be reported");
});

test("OGR03 keeps flagging the classic gh[ps]_ token shapes", () => {
  const legacy = "ghp_" + "Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv1Wx2Yz";
  const result = scanLines("legacy.mjs", [`const deployRef = "${legacy}";`]);
  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
});

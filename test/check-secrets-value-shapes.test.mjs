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
import { findSecret, loadSecretPatterns } from "../scripts/cli-common.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCANNER = path.join(ROOT, "validation", "check-secrets.sh");

// ClickUp's actual token shape: pk_<numeric user id>_<key>. The pattern requires the numeric
// middle segment so it cannot match SQL primary-key constraint names, Stripe PUBLISHABLE
// pk_live_/pk_test_ keys, or ALL-CAPS PK_* constants (see the negative tests below).
const CLICKUP_VALUE = "pk_" + "4753994_" + "W3JM4VBT2RKD8NCZ5QHY6FW2";
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

test("OGR03 accepts a secret-shaped value declared by a VALUE-BOUND fixture marker", () => {
  // Prefix form (first 12+ chars of the declared value) and full-value form both work.
  const result = scanLines("fixture.mjs", [
    `const clickupToken = "${CLICKUP_VALUE}"; // aios-secret-fixture:${CLICKUP_VALUE.slice(0, 16)}`,
    `const linearToken = "${LINEAR_VALUE}"; // aios-secret-fixture:${LINEAR_VALUE}`,
  ]);
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 0, output);
  assert.match(output, /OGR03 PASSED/);
});

test("OGR03: a fixture declaration suppresses only the declared value, not the line", () => {
  // The round-2 whole-line semantics was a CRITICAL-gate bypass: a real token sharing a
  // line with ANY marker (think one-line JSON, minified bundles, transcripts) scanned
  // clean. A marker must suppress only matches of the value it declares.
  const realShapedGithub = "ghp_" + "aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW3xYz8Q";
  const result = scanLines("bundle.json", [
    `{"deploy":"${realShapedGithub}","note":"aios-secret-fixture:${CLICKUP_VALUE.slice(0, 16)}"}`,
  ]);
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 1, output);
  assert.match(output, /line 1: \[REDACTED\]/);
  assert.ok(!output.includes(realShapedGithub), "diagnostics must not echo the token");
});

test("OGR03: a fixture declaration does not cover a different value on the same line", () => {
  const result = scanLines("mixed.mjs", [
    `const declared = "${CLICKUP_VALUE}"; const undeclared = "${LINEAR_VALUE}"; // aios-secret-fixture:${CLICKUP_VALUE.slice(0, 16)}`,
  ]);
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 1, output);
  assert.match(output, /line 1: \[REDACTED\]/);
});

test("OGR03 does not cry wolf on pk_-prefixed non-secrets", () => {
  const result = scanLines("innocent.sql", [
    // SQL primary-key constraint name: pk_ followed by a long identifier, no numeric segment.
    "ALTER TABLE user_sessions ADD CONSTRAINT pk_user_sessions_created_at PRIMARY KEY (id);",
    // Stripe PUBLISHABLE key — designed to be public, not a secret.
    `const stripePublishable = "${"pk_live_" + "51Hqx" + "Vt8KDmR2wNbYcPeJaGuZfL"}";`,
    // ALL-CAPS constant whose NAME starts with PK_ (the scan is case-insensitive).
    "const PK_DEFAULT_RETRY_WINDOW_MS = 500;",
  ]);
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 0, output);
  assert.match(output, /OGR03 PASSED/);
});

test("OGR03 flags every gh[pousr]_ token class", () => {
  // All five classic GitHub prefixes — a silent narrowing of gh[pousr]_ must go red here.
  const body = "Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv1Wx2Yz";
  const prefixes = ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"];
  for (const prefix of prefixes) {
    const result = scanLines("ref.mjs", [`const deployRef = "${prefix + body}";`]);
    assert.equal(result.status, 1, `${prefix}: ${result.stdout}${result.stderr}`);
  }
});

test("findSecret (aios push/review/promote) shares the value rules and the fixture escape", () => {
  const patterns = loadSecretPatterns();
  const plain = `const clickupProjectRef = "${CLICKUP_VALUE}";`;
  assert.ok(findSecret(plain, patterns), "undeclared provider-shaped value must be flagged");
  assert.equal(
    findSecret(`${plain} // aios-secret-fixture:${CLICKUP_VALUE.slice(0, 16)}`, patterns),
    null,
    "a value-bound declaration must clear the push/review leak check"
  );
  const realShapedGithub = "ghp_" + "aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW3xYz8Q";
  assert.ok(
    findSecret(
      `{"deploy":"${realShapedGithub}","note":"aios-secret-fixture:${CLICKUP_VALUE.slice(0, 16)}"}`,
      patterns
    ),
    "a marker must not exempt a different secret sharing its line"
  );
  assert.ok(
    findSecret(
      [
        `const declared = "${CLICKUP_VALUE}"; // aios-secret-fixture:${CLICKUP_VALUE.slice(0, 16)}`,
        `const undeclared = "${LINEAR_VALUE}";`,
      ].join("\n"),
      patterns
    ),
    "an undeclared value on another line must still be flagged"
  );
  // The scanner greps with -i; loadSecretPatterns must match that case-insensitivity.
  assert.ok(
    findSecret(`const ref = "${CLICKUP_VALUE.toLowerCase()}";`, patterns),
    "pattern compilation must be case-insensitive like the OGR03 grep -i"
  );
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCANNER = path.join(ROOT, "validation", "check-secrets.sh");

function repoWith(filename, content) {
  const dir = mkdtempSync(path.join(tmpdir(), "aio703-secrets-"));
  execFileSync("git", ["-C", dir, "init", "-q"]);
  writeFileSync(path.join(dir, filename), content);
  execFileSync("git", ["-C", dir, "add", filename]);
  return dir;
}

function scan(dir) {
  return spawnSync("bash", [SCANNER, dir], { encoding: "utf8" });
}

test("OGR03 permits only the committed non-secret fixture, prompt, and document-id forms", () => {
  const slackExamples = [
    "xoxb-" + "EXAMPLE-NOT-REAL",
    "xoxb-" + "SUPER-secret-token-zzz999",
    "xoxb-" + "1234567890-abcdefABCDEF",
  ];
  const lines = [
    `const secret = "${"test-auth-secret-which-is-long-enough"}";`,
    ...slackExamples.map((value) => `const token = "${value}";`),
    `const key = "${"sk-ant-" + "REAL-anthropic-key-xyz"}";`,
    `password: "${"example-invite-password"}",`,
    `credentialSummary({ password: "${"generated"}", supplied: false })`,
    `ADMIN_PASSWORD: '${"A strong first-login password"}',`,
    `"fileToken": "${"6db673b2-631f-4222-8f5d-b29becb46639"}"`,
  ];
  const dir = repoWith("aios-design.pen", `${lines.join("\n")}\n`);
  try {
    const result = scan(dir);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /OGR03 PASSED/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OGR03 still blocks nearby real-secret counterexamples", () => {
  const opaque = "A7" + "q9".repeat(12);
  const realisticSlack = "xoxb-" + "123456789012-123456789012-" + opaque;
  const uuid = "8a455a68-71f6-4e55-9a94-84285dbc3210";
  const passwordField = "ADMIN_" + "PASSWORD";
  const lines = [
    `const secret = "${"test-auth-secret-which-is-long-enough"}"; const secret = "${opaque}";`,
    `const token = "${realisticSlack}";`,
    `${passwordField}: '${opaque}',`,
    `"fileToken": "${opaque}"`,
    `"token": "${uuid}"`,
    `"fileToken": "${uuid}"`,
  ];
  const dir = repoWith("counterexamples.txt", `${lines.join("\n")}\n`);
  try {
    const result = scan(dir);
    const output = `${result.stdout}${result.stderr}`;
    assert.equal(result.status, 1, output);
    assert.match(output, /Generic Secret/);
    assert.match(output, /Generic Token/);
    // AIO-952: the Slack rule now lives only in secret-patterns.txt (the inline copy
    // lacked the AIO-965 left boundary), so its finding label is "Shared pattern".
    assert.match(output, /Shared pattern/);
    assert.match(output, /Password Assignment/);
    assert.match(output, /OGR03 FAILED/);
    assert.match(output, /line 1: \[REDACTED\]/);
    assert.ok(!output.includes(opaque), "multi-rule diagnostics must not echo the opaque secret");
    assert.ok(
      !output.includes(realisticSlack),
      "multi-rule diagnostics must not echo the Slack token"
    );
    assert.ok(!output.includes(uuid), "multi-rule diagnostics must not echo token-shaped UUIDs");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OGR03 treats a tracked NUL-containing file as text and blocks its secret", () => {
  const awsKey = "AK" + "IA" + "Q".repeat(16);
  const dir = repoWith(
    "payload.dat",
    Buffer.concat([Buffer.from("binary-prefix\0aws_access_key = "), Buffer.from(awsKey)])
  );
  try {
    const result = scan(dir);
    const output = `${result.stdout}${result.stderr}`;
    assert.equal(result.status, 1, output);
    assert.match(output, /AWS Access Key/);
    assert.match(output, /payload\.dat/);
    assert.match(output, /line 1: \[REDACTED\]/);
    assert.match(output, /OGR03 FAILED/);
    assert.ok(!output.includes(awsKey), "NUL-containing file diagnostics must not echo the secret");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

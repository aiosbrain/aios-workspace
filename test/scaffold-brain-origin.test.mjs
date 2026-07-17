import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { persistBrainOrigin } from "../scripts/onboard-config.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCAFFOLD = path.join(ROOT, "scripts", "scaffold-project.sh");

function tempOutput(prefix) {
  const output = mkdtempSync(path.join(tmpdir(), prefix));
  rmSync(output, { recursive: true, force: true });
  return output;
}

function args(output, brainUrl) {
  return [
    SCAFFOLD,
    "--context",
    "employee",
    "--slug",
    "origin-test",
    "--owner",
    "tester",
    "--output",
    output,
    "--brain-url",
    brainUrl,
  ];
}

test("non-interactive scaffold refuses an unconfirmed remote origin before mutation", () => {
  const output = tempOutput("scaffold-remote-origin-");
  try {
    const result = spawnSync("bash", args(output, "https://brain.example.com/t/aios"), {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /requires human confirmation/i);
    assert.throws(() => readFileSync(path.join(output, "aios.yaml"), "utf8"));
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test("loopback scaffold normalizes a copied Team page to its origin", () => {
  const output = tempOutput("scaffold-local-origin-");
  try {
    execFileSync("bash", args(output, "http://localhost:3000/t/aios"), {
      stdio: ["ignore", "ignore", "pipe"],
    });
    const yaml = readFileSync(path.join(output, "aios.yaml"), "utf8");
    assert.match(yaml, /^brain_url: "http:\/\/localhost:3000"$/m);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test("persistBrainOrigin writes only a canonical confirmed origin", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "persist-brain-origin-"));
  try {
    const file = path.join(repo, "aios.yaml");
    writeFileSync(file, 'project: "keep-me"\nbrain_url: ""\nteam_id: "legacy"\n');
    const result = persistBrainOrigin(repo, "https://brain.example.com/api/v1/me");
    assert.deepEqual(result, { origin: "https://brain.example.com", changed: true });
    assert.equal(
      readFileSync(file, "utf8"),
      'project: "keep-me"\nbrain_url: "https://brain.example.com"\nteam_id: "legacy"\n'
    );
    assert.throws(
      () => persistBrainOrigin(repo, "https://brain.example.com/not-a-brain-path"),
      /not a recognized Brain page/
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

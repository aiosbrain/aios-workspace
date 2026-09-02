/**
 * connector-routing-classifier-v2.test.mjs — AIO-1072: the v2 target classifier.
 *
 * Field-scoped, versioned, order/nesting-independent: only declared identifier slots
 * classify a payload as AIOS-targeted; prose (top-level or nested under an
 * identifier-named wrapper) never does. Split from connector-routing-guard.test.mjs
 * for the file-size cap; same conventions (real hook over real PreToolUse payloads).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  classifyMcp,
  targetIdentifyingValues,
  DEFAULT_STALE,
} from "../hooks/connector-routing-guard.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(DIR, "..", "hooks", "connector-routing-guard.mjs");

/** Run the real hook over a real PreToolUse payload (same shape as the main suite). */
function runHook(payload, { env = {}, cwd } = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [HOOK],
      { encoding: "utf8", cwd, env: { ...process.env, ...env } },
      (err, stdout, stderr) => resolve({ status: err ? (err.code ?? 1) : 0, stdout, stderr })
    );
    child.stdin.on("error", (e) => {
      if (e.code !== "EPIPE") throw e;
    });
    child.stdin.end(typeof payload === "string" ? payload : JSON.stringify(payload));
  });
}

const mcp = (tool_name, tool_input, cwd) => ({ tool_name, tool_input, cwd });

// ── AIO-1072: target classifier v2 — field-scoped, versioned, order/nesting-independent ─────

test("v2: a NESTED AIOS-targeted payload classifies (identifier fields at depth)", () => {
  const r = classifyMcp("mcp__plugin_linear_linear__update_issue", {
    update: { relations: { parent: { issueId: "aio-1072" } } },
    title: "unrelated",
  });
  assert.equal(r.decision, "block");
  assert.match(r.reason, /classifier v2/);
});

test("v2: field ORDER is irrelevant — reordered payloads classify identically", () => {
  const a = classifyMcp("mcp__linear__get", { id: "AIO-7", title: "x" });
  const b = classifyMcp("mcp__linear__get", { title: "x", id: "AIO-7" });
  assert.equal(a.decision, "block");
  assert.deepEqual(a, b);
});

test('v2: identifier ARRAYS classify (issueIds: ["AIO-9"])', () => {
  const r = classifyMcp("mcp__linear__batch", { issueIds: ["ACME-1", "AIO-9"] });
  assert.equal(r.decision, "block");
});

test("v2: prose NESTED under an identifier-named wrapper never classifies (Bugbot round 1)", () => {
  // `issue` is a target field, but its OBJECT value is a wrapper: only its own
  // identifier slots count — the nested description prose must not be harvested.
  const payload = {
    issue: { id: "CUST-41", description: "port the exporter — similar to AIO-976 upstream" },
  };
  assert.deepEqual(targetIdentifyingValues(payload), ["CUST-41"]);
  const r = classifyMcp("mcp__plugin_linear_linear__update_issue", payload);
  assert.equal(r.decision, "warn", "customer payload with nested AIO mention stays allowed");
  // …while a genuinely AIOS-targeted envelope nested just as deep still classifies.
  const targeted = classifyMcp("mcp__plugin_linear_linear__update_issue", {
    issue: { id: "AIO-976", description: "customer text" },
  });
  assert.equal(targeted.decision, "block");
});

test("stale-path needles stay in LOCKSTEP with the check-retired-routes gate", () => {
  // The hook ships standalone into workspaces, so the two lists cannot share an
  // import — this test is the lockstep. Every RETIRED_REFS label in the repo gate
  // must be covered by a DEFAULT_STALE needle (dir prefixes count as coverage).
  const gateSource = readFileSync(
    path.join(DIR, "..", "scripts", "check-retired-routes.mjs"),
    "utf8"
  );
  const labels = [...gateSource.matchAll(/label: "([^"]+)"/g)].map((m) => m[1]);
  assert.ok(labels.length >= 4, "gate labels parsed");
  const coverage = {
    "skills/aios-linear/linear.mjs": "aios-linear/linear.mjs",
    "linear-query-client": "linear-direct/",
    "slack.py": "slack-personal/slack.py",
    "slack-activity-pull": "slack-activity-pull.mjs",
  };
  for (const label of labels) {
    const needleFragment = coverage[label];
    assert.ok(
      needleFragment,
      `gate label '${label}' has no lockstep mapping — add it here AND to DEFAULT_STALE`
    );
    assert.ok(
      DEFAULT_STALE.some((n) => n.includes(needleFragment)),
      `DEFAULT_STALE lacks a needle covering retired route '${label}'`
    );
  }
});

test("v2: customer prose that merely MENTIONS an AIO issue stays allowed (advisory warn)", async () => {
  const r = await runHook(
    mcp("mcp__plugin_linear_linear__create_issue", {
      teamId: "acme-corp",
      title: "port the exporter",
      description: "Similar shape to AIO-976 in the AIOS repo — see their approach.",
    })
  );
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /advisory/);
  assert.doesNotMatch(r.stderr, /BLOCKED/);
});

test("v2: `classifier: 1` in config restores the legacy full-payload scan", async () => {
  const ws = mkdtempSync(path.join(tmpdir(), "crg-v1-"));
  mkdirSync(path.join(ws, ".aios"), { recursive: true });
  writeFileSync(path.join(ws, ".aios", "connector-routing.json"), '{ "classifier": 1 }\n');
  const r = await runHook(
    mcp(
      "mcp__plugin_linear_linear__create_issue",
      { teamId: "acme-corp", title: "x", description: "mentions AIO-976 only in prose" },
      ws
    )
  );
  assert.equal(r.status, 2, "classifier v1 blocks on any payload mention, by request");
  assert.match(r.stderr, /classifier v1/);
});

test("v2: an OVERSIZED identifiably-Linear-MCP payload still classifies (fails closed)", async () => {
  const filler = "x".repeat(1_100_000);
  const raw = `{"tool_name":"mcp__plugin_linear_linear__update_issue","tool_input":{"id":"AIO-3","description":"${filler}"}}`;
  const r = await runHook(raw);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /could not be classified/);
});

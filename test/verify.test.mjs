#!/usr/bin/env node

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { rankFindings } from "../scripts/consolidate-findings.mjs";
import { cmdVerify, mergeLaneResults, parseVerifyArgs, MAX_LANES } from "../scripts/verify.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(DIR, "..");
const AIOS = path.join(REPO, "scripts", "aios.mjs");
const VERIFY_SOURCE = path.join(REPO, "scripts", "verify.mjs");

function runGit(repo, args) {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trimEnd();
}

function makeRepo() {
  const repo = mkdtempSync(path.join(tmpdir(), "aios-verify-"));
  runGit(repo, ["init", "-q"]);
  runGit(repo, ["config", "user.name", "AIOS Verify Test"]);
  runGit(repo, ["config", "user.email", "verify@example.invalid"]);
  writeFileSync(path.join(repo, "README.md"), "one\n");
  runGit(repo, ["add", "README.md"]);
  runGit(repo, ["commit", "-qm", "first"]);
  writeFileSync(path.join(repo, "README.md"), "one\ntwo\n");
  runGit(repo, ["add", "README.md"]);
  runGit(repo, ["commit", "-qm", "second"]);
  return repo;
}

function runCli(repo, args, env = {}) {
  const result = spawnSync(process.execPath, [AIOS, ...args, "--repo", repo], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", ...env },
  });
  return {
    code: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

test("argument contract: defaults, cap, and usage errors", () => {
  assert.equal(parseVerifyArgs(["HEAD"]).lanes, 3);
  assert.equal(parseVerifyArgs(["HEAD", "--lanes", "1"]).lanes, 1);
  const capped = parseVerifyArgs(["HEAD", "--lanes", String(MAX_LANES + 1)]);
  assert.equal(capped.exitCode, 4);
  assert.match(capped.error, /hard cap of 8/);
  assert.equal(parseVerifyArgs([]).exitCode, 4);
  assert.equal(parseVerifyArgs(["HEAD", "--lanes", "many"]).exitCode, 4);
});

test("unknown sha exits 4 and --lanes 9 names the cap", () => {
  const repo = makeRepo();
  try {
    const unknown = runCli(repo, ["verify", "not-a-commit"]);
    assert.equal(unknown.code, 4);
    assert.match(unknown.stderr, /unknown commit 'not-a-commit'/);

    const capped = runCli(repo, ["verify", "HEAD", "--lanes", "9"]);
    assert.equal(capped.code, 4);
    assert.match(capped.stderr, /hard cap of 8/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("missing provider key fails before launching a lane", async () => {
  const repo = makeRepo();
  let calls = 0;
  const previous = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try {
    const originalError = console.error;
    console.error = () => {};
    try {
      const code = await cmdVerify(repo, ["HEAD"], {
        runCouncil: async () => {
          calls++;
          throw new Error("must not run");
        },
      });
      assert.notEqual(code, 0);
    } finally {
      console.error = originalError;
    }
    assert.equal(calls, 0);

    const cli = runCli(repo, ["verify", "HEAD"], { OPENROUTER_API_KEY: "" });
    assert.notEqual(cli.code, 0);
    assert.match(cli.stderr, /OPENROUTER_API_KEY is not set/);
    assert.match(cli.stderr, /zero lanes/);
  } finally {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previous;
    rmSync(repo, { recursive: true, force: true });
  }
});

test("lane findings use consolidate-findings' stable severity order", () => {
  const laneResults = [
    {
      model: "model-a",
      ok: true,
      text: JSON.stringify([
        { severity: "low", title: "low-first", detail: "a" },
        { severity: "HIGH", title: "high-first", detail: "b" },
      ]),
    },
    {
      model: "model-b",
      ok: true,
      text: JSON.stringify([
        { severity: "medium", title: "medium", detail: "c" },
        { severity: "high", title: "high-second", detail: "d" },
      ]),
    },
  ];
  const merged = mergeLaneResults(laneResults);
  const fixture = laneResults.flatMap((result, laneIndex) =>
    JSON.parse(result.text).map((finding) => ({
      ...finding,
      lane: laneIndex + 1,
      model: result.model,
    }))
  );
  assert.deepEqual(
    merged.map((finding) => finding.title),
    rankFindings(fixture).map((finding) => finding.title)
  );
  assert.deepEqual(
    merged.map((finding) => finding.title),
    ["high-first", "high-second", "medium", "low-first"]
  );
});

test("invalid or failed lanes fail closed as High findings", () => {
  const merged = mergeLaneResults([
    { model: "bad-json", ok: true, text: "not json" },
    { model: "down", ok: false, error: "provider unavailable" },
  ]);
  assert.equal(merged.length, 2);
  assert.ok(merged.every((finding) => finding.severity === "High"));
});

test("full JSON CLI run is report-only and preserves repository fingerprint", () => {
  const repo = makeRepo();
  const preload = path.join(repo, "mock-fetch.mjs");
  writeFileSync(
    preload,
    [
      "globalThis.fetch = async () => ({",
      "  ok: true,",
      "  json: async () => ({ choices: [{ message: { content: '[]' } }] }),",
      "  text: async () => '',",
      "});",
      "",
    ].join("\n")
  );

  try {
    const before = {
      status: runGit(repo, ["status", "--porcelain"]),
      head: runGit(repo, ["rev-parse", "HEAD"]),
    };
    const result = runCli(repo, ["verify", "HEAD", "--lanes", "2", "--json"], {
      OPENROUTER_API_KEY: "test-only-key",
      NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
    });
    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.lanes, 2);
    assert.equal(report.models.length, 2);
    assert.deepEqual(report.findings, []);
    assert.equal(report.blocking, false);

    const after = {
      status: runGit(repo, ["status", "--porcelain"]),
      head: runGit(repo, ["rev-parse", "HEAD"]),
    };
    assert.deepEqual(after, before);
    assert.equal(existsSync(path.join(repo, ".aios")), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("--out is the only explicit report file write", async () => {
  const repo = makeRepo();
  try {
    const code = await cmdVerify(repo, ["HEAD", "--lanes", "2", "--json", "--out", "report.json"], {
      apiKey: "test-only-key",
      runCouncil: async (_repo, _rest, options) => {
        assert.equal(options.persist, false);
        assert.equal(options.print, false);
        return {
          models: ["model-a", "model-b"],
          results: [
            { model: "model-a", ok: true, text: "[]" },
            { model: "model-b", ok: true, text: "[]" },
          ],
        };
      },
    });
    assert.equal(code, 0);
    assert.equal(JSON.parse(readFileSync(path.join(repo, "report.json"), "utf8")).lanes, 2);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("static report-only guard permits only read-side git calls and no GitHub CLI", () => {
  const source = readFileSync(VERIFY_SOURCE, "utf8");
  assert.doesNotMatch(source, /execFileSync\(\s*["']gh["']/);
  assert.doesNotMatch(
    source,
    /gitRead\([^)]*\[\s*["'](?:commit|push|branch|merge|checkout|switch|reset|clean|add)["']/
  );
});

// Unknown-command UX (audit S6-4).
//
// `aios <typo>` used to print the whole 176-line help to STDOUT, exit 1, and say nothing about
// which word was unknown — so `aios bogus 2>err.log` captured nothing, and `aios statu` (one
// character off `status`, against ~55 registered verbs) got no suggestion. `aios inbox` and
// `aios asks` already had edit-distance did-you-mean for their subcommands; top level did not.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nearestCommand, commandNames } from "../scripts/cli/registry.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "scripts", "aios.mjs");

function run(args) {
  try {
    const stdout = execFileSync("node", [CLI, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

test("nearestCommand matches a one-character typo", () => {
  assert.equal(nearestCommand("statu"), "status");
  assert.equal(nearestCommand("psuh"), "push");
});

test("nearestCommand gives up on genuine nonsense rather than guessing", () => {
  assert.equal(nearestCommand("bogusquux"), null);
  assert.equal(nearestCommand(""), null);
});

test("every registered verb resolves to itself", () => {
  for (const name of commandNames()) assert.equal(nearestCommand(name), name);
});

test("an unknown command names itself on stderr and still exits 1", () => {
  const r = run(["bogusquux"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown command: bogusquux/);
});

test("a near-miss suggests the real verb", () => {
  const r = run(["statu"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown command: statu/);
  assert.match(r.stderr, /did you mean `aios status`\?/);
});

test("the help itself stays on stdout — the diagnostic is the only stderr line", () => {
  const r = run(["bogusquux"]);
  assert.ok(r.stdout.includes("aios — AIOS Team Brain sync client"));
  assert.equal(r.stderr.trim().split("\n").length, 1);
});

test("`aios inbox` is discoverable from the help (it used to be hidden)", () => {
  const r = run(["--help"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /aios inbox \[list\]/);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createAiosJson } from "./aios-json.mjs";

/** Stand up a fake `aios.mjs` whose behavior is driven by its first argument. */
function fakeCli() {
  const dir = mkdtempSync(path.join(tmpdir(), "aios-json-"));
  const cli = path.join(dir, "fake-aios.mjs");
  writeFileSync(
    cli,
    `
const [mode] = process.argv.slice(2);
let stdin = "";
for await (const c of process.stdin) stdin += c;
if (mode === "envelope") console.log(JSON.stringify({ status: 422, body: { ok: false, stdin } }));
else if (mode === "raw") console.log(JSON.stringify({ skills: [], args: process.argv.slice(2) }));
else if (mode === "noisy") {
  console.log("stray non-JSON line");
  console.log(JSON.stringify({ status: 200, body: { ok: true } }));
} else console.log("not json at all");
`
  );
  return { dir, cli };
}

test("aiosJson: envelope results pass through with --repo pinned and stdin relayed", async () => {
  const { dir, cli } = fakeCli();
  try {
    const aiosJson = createAiosJson({ cliPath: cli, repo: dir });
    const r = await aiosJson(["envelope"], { stdin: '{"secrets":{"K":"v"}}' });
    assert.deepEqual(r, { status: 422, body: { ok: false, stdin: '{"secrets":{"K":"v"}}' } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("aiosJson: raw mode wraps a bare document as a 200 body (catalog surface)", async () => {
  const { dir, cli } = fakeCli();
  try {
    const aiosJson = createAiosJson({ cliPath: cli, repo: dir });
    const r = await aiosJson(["raw", "--json"], { raw: true });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.skills, []);
    // the runner appends --repo <repo> so every surface stays pinned to the workspace
    assert.deepEqual(r.body.args, ["raw", "--json", "--repo", dir]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("aiosJson: parses only the LAST stdout line; garbage or spawn failure → 500", async () => {
  const { dir, cli } = fakeCli();
  try {
    const aiosJson = createAiosJson({ cliPath: cli, repo: dir });
    assert.deepEqual(await aiosJson(["noisy"]), { status: 200, body: { ok: true } });

    const garbage = await aiosJson(["garbage"]);
    assert.equal(garbage.status, 500);
    assert.equal(garbage.body.ok, false);

    const missing = createAiosJson({ cliPath: path.join(dir, "missing.mjs"), repo: dir });
    assert.equal((await missing(["envelope"])).status, 500);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

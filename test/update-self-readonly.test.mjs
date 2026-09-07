import test from "node:test";
import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

test("registry self-upgrade refuses read-only flags before invoking npm", () => {
  const source = fileURLToPath(new URL("../", import.meta.url));
  const root = mkdtempSync(path.join(tmpdir(), "aios-self-readonly-"));
  try {
    const registry = path.join(root, "registry");
    const bin = path.join(root, "bin");
    const calls = path.join(root, "npm-calls");
    const home = path.join(root, "home");
    mkdirSync(bin);
    mkdirSync(home);
    cpSync(path.join(source, "scripts"), path.join(registry, "scripts"), { recursive: true });
    symlinkSync(path.join(source, "packages"), path.join(registry, "packages"), "dir");
    symlinkSync(path.join(source, "node_modules"), path.join(registry, "node_modules"), "dir");
    mkdirSync(path.join(registry, "scaffold", "scripts"), { recursive: true });
    writeFileSync(path.join(registry, "scaffold", "scripts", "aios.mjs"), "// marker\n");
    writeFileSync(
      path.join(registry, "package.json"),
      JSON.stringify({ name: "@aiosbrain/aios", version: "2.0.0", type: "module" })
    );
    writeFileSync(
      path.join(registry, "build.json"),
      JSON.stringify({ sha: "b".repeat(40), version: "2.0.0" })
    );
    writeFileSync(path.join(bin, "npm"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$NPM_CALLS"\n', {
      mode: 0o755,
    });
    const moduleUrl = pathToFileURL(path.join(registry, "scripts", "update.mjs")).href;
    const run = (args) =>
      spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { cmdUpdate } from ${JSON.stringify(moduleUrl)}; const result = await cmdUpdate(${JSON.stringify(home)}, {}, ${JSON.stringify(args)}); console.log(JSON.stringify(result)); process.exitCode = result.exitStatus;`,
        ],
        { cwd: home, env: { HOME: home, PATH: bin, NPM_CALLS: calls }, encoding: "utf8" }
      );

    for (const flag of ["--dry-run", "--check", "--preview"]) {
      for (const args of [
        ["--self", flag],
        [flag, "--self"],
      ]) {
        const result = run(args);
        assert.notEqual(result.status, 0, `${args.join(" ")} must refuse`);
        assert.match(result.stderr, /--self cannot be combined with/);
        assert.equal(existsSync(calls), false, "read-only request must never invoke npm");
      }
    }
    const positive = run(["--self"]);
    assert.equal(positive.status, 0, positive.stderr);
    assert.equal(readFileSync(calls, "utf8"), "i -g @aiosbrain/aios@latest\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

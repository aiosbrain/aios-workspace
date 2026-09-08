import test from "node:test";
import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

test("registry self-upgrade refuses read-only flags before invoking npm", () => {
  const source = fileURLToPath(new URL("../", import.meta.url));
  const root = mkdtempSync(path.join(tmpdir(), "aios-self-readonly-"));
  try {
    const prefix = path.join(root, "install");
    let registry = path.join(prefix, "node_modules", "@aiosbrain", "aios");

    mkdirSync(registry, { recursive: true });
    writeFileSync(path.join(prefix, "package.json"), JSON.stringify({ private: true }));
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
    writeFileSync(
      path.join(bin, "npm"),
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$NPM_CALLS"\nif [ "$1" = root ]; then printf "%s\\n" "${NPM_GLOBAL_ROOT:-/unrelated/global/node_modules}"; fi\nif [ "$1" = prefix ]; then printf "%s\\n" "$NPM_PREFIX"; fi\n',
      {
        mode: 0o755,
      }
    );
    const run = (args) =>
      spawnSync(process.execPath, [path.join(registry, "scripts", "aios.mjs"), "update", ...args], {
        cwd: home,
        env: {
          HOME: home,
          PATH: bin,
          NPM_CALLS: calls,
        },
        encoding: "utf8",
      });

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
    for (const args of [
      ["--self", "--force"],
      ["--self", "--repo", home],
      ["--self", "--self"],
      ["--self", "--result-file", calls],
      ["--repo", home, "--repo", home],
      ["--from"],
    ]) {
      const result = run(args);
      assert.notEqual(result.status, 0, args.join(" "));
      assert.equal(
        existsSync(calls),
        false,
        "invalid command must not invoke npm or write its result path"
      );
    }
    const victim = path.join(home, "keep.txt");
    writeFileSync(victim, "keep these bytes\n");
    const alias = path.join(home, "keep-link");
    symlinkSync(victim, alias);
    for (const mode of ["--check", "--preview", "--dry-run"])
      for (const target of [victim, alias]) {
        const result = run([mode, "--result-file", target]);
        assert.notEqual(result.status, 0);
        assert.equal(readFileSync(victim, "utf8"), "keep these bytes\n");
        assert.equal(existsSync(calls), false);
      }
    const positive = run(["--self"]);
    assert.equal(positive.status, 0, positive.stderr);
    assert.equal(
      readFileSync(calls, "utf8"),
      `i --prefix ${realpathSync(prefix)} @aiosbrain/aios@latest\n`
    );
    rmSync(calls);
    const workspace = path.join(home, "workspace");
    mkdirSync(path.join(workspace, "scripts"), { recursive: true });
    writeFileSync(path.join(workspace, "aios.yaml"), "owner: fixture\n");
    cpSync(
      path.join(source, "scaffold/scripts/aios.mjs"),
      path.join(workspace, "scripts/aios.mjs")
    );
    symlinkSync(process.execPath, path.join(bin, "node"));
    symlinkSync(path.join(registry, "scripts/aios.mjs"), path.join(bin, "aios"));
    const shim = spawnSync(
      process.execPath,
      [path.join(workspace, "scripts/aios.mjs"), "update", "--self"],
      {
        cwd: workspace,
        env: { HOME: home, PATH: bin, NPM_CALLS: calls },
        encoding: "utf8",
      }
    );
    assert.equal(shim.status, 0, shim.stderr);
    assert.equal(
      readFileSync(calls, "utf8"),
      `i --prefix ${realpathSync(prefix)} @aiosbrain/aios@latest\n`
    );
    rmSync(calls);
    mkdirSync(path.join(prefix, "lib"));
    const globalRoot = path.join(prefix, "lib", "node_modules");
    renameSync(path.join(prefix, "node_modules"), globalRoot);
    registry = path.join(globalRoot, "@aiosbrain", "aios");
    mkdirSync(path.join(prefix, "bin"));
    symlinkSync(path.join(registry, "scripts/aios.mjs"), path.join(prefix, "bin/aios"));
    // The npm stub still reports an unrelated ambient global root.
    const global = run(["--self"]);
    assert.equal(global.status, 0, global.stderr);
    assert.equal(
      readFileSync(calls, "utf8"),
      `i -g --prefix ${realpathSync(prefix)} @aiosbrain/aios@latest\n`
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

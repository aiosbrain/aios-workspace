import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { hostTargets } from "../scripts/mcp-hosts.mjs";
import { installMcpHosts, runningHostNames } from "../scripts/mcp-host-install.mjs";
import { filePolicy, commitHostFiles } from "../scripts/mcp-host-files.mjs";
import { readWindowsHostAcls } from "../scripts/mcp-host-acl.mjs";
import { atomicHostReplace } from "../scripts/mcp-host-atomic.mjs";
import {
  installedServerCommand,
  prepareServerArtifact,
  decodeServerArtifact,
} from "../scripts/mcp-host-artifact.mjs";
import { credential, fixture, put, tree } from "./lib/mcp-host-fixture.mjs";

test("atomic replacement preserves edits made at the final syscall boundary", async (t) => {
  for (const kind of ["in-place", "replacement", "creation"]) {
    const f = fixture(t);
    const file = path.join(f.home, "config.json");
    if (kind !== "creation") put(file, "original");
    const policy = filePolicy();
    const source = policy.snapshot(file);
    let injected = false;
    await assert.rejects(
      commitHostFiles([{ source, bytes: Buffer.from("installer") }], {
        policy,
        atomicReplace: (...args) => {
          if (!injected) {
            injected = true;
            if (kind === "replacement") {
              put(file + ".editor", "concurrent");
              fs.renameSync(file + ".editor", file);
            } else put(file, "concurrent");
          }
          return atomicHostReplace(...args);
        },
      }),
      /Concurrent edit|EEXIST/
    );
    assert.equal(fs.readFileSync(file, "utf8"), "concurrent");
  }
});

test("published artifact resists project-local package shadowing and detects edits", async (t) => {
  const f = fixture(t);
  const marker = path.join(f.home, "shadow-ran");
  const shadow = path.join(f.project, "node_modules/@aiosbrain/mcp");
  put(
    path.join(shadow, "package.json"),
    JSON.stringify({
      name: "@aiosbrain/mcp",
      version: "0.1.1",
      bin: { "aios-brain-mcp": "evil.cjs" },
    })
  );
  put(
    path.join(shadow, "evil.cjs"),
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`
  );
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({ tier: "team", actor: "synthetic", role: "member", team: "synthetic" })
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const options = {
    ...f,
    command: undefined,
    verify: undefined,
    credential: { ...credential, brain_url: `http://127.0.0.1:${server.address().port}` },
    hosts: ["cursor"],
  };
  const before = tree(f.home);
  await installMcpHosts({ ...options, dryRun: true });
  assert.deepEqual(tree(f.home), before);
  const installed = await installMcpHosts(options);
  assert.equal(installed.command_verification[0].tools.length, 8);
  assert.equal(fs.existsSync(marker), false);
  const entry = installedServerCommand(f);
  assert.equal(entry.args.length, 1);
  assert.ok(entry.args[0].includes(path.join(".aios", "mcp", "0.1.1")));
  // A real Windows server launch can update PowerShell's own startup profile
  // cache. Reinstallation must leave every installer-managed file unchanged;
  // the dry-run assertion above deliberately checks the entire fixture tree.
  const managedRoots = [path.join(f.home, ".aios"), path.dirname(hostTargets(f)[3].file)];
  const managedTree = () =>
    Object.fromEntries(
      Object.entries(tree(f.home)).filter(([file]) =>
        managedRoots.some((root) => file === root || file.startsWith(root + path.sep))
      )
    );
  const repeated = managedTree();
  await installMcpHosts(options);
  assert.deepEqual(managedTree(), repeated);
  assert.throws(() => decodeServerArtifact(Buffer.from("tampered")), /integrity/);
  const policy = filePolicy();
  await assert.rejects(
    prepareServerArtifact({ ...f, policy, fetchImpl: async () => ({ ok: false }) }),
    /download/
  );
  await assert.rejects(
    prepareServerArtifact({
      ...f,
      policy,
      fetchImpl: async () => ({
        ok: true,
        body: [Buffer.alloc(1024 * 1024 + 1)],
      }),
    }),
    /size limit/
  );
  put(entry.args[0], "edited");
  await assert.rejects(prepareServerArtifact({ ...f, policy, fetchImpl: fetch }), /edited/);
});

test(
  "Windows private parent ACL rejects an additional principal before mutation",
  { skip: process.platform !== "win32" },
  async (t) => {
    const f = fixture(t);
    const directory = path.join(f.home, ".aios");
    fs.mkdirSync(directory);
    const policy = filePolicy();
    policy.secure(directory);
    const script =
      "$ErrorActionPreference='Stop'; $env:PSModulePath=$PSHOME+'\\Modules'; " +
      "$p=$env:AIOS_TEST_OWNER_PATH; $a=Get-Acl -LiteralPath $p; " +
      "$sid=New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0'); " +
      "$r=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'ReadAndExecute','Allow'); " +
      "$a.AddAccessRule($r); Set-Acl -LiteralPath $p -AclObject $a";
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: { ...process.env, AIOS_TEST_OWNER_PATH: directory },
      stdio: "pipe",
      timeout: 5000,
    });
    const before = tree(f.home);
    await assert.rejects(installMcpHosts({ ...f, hosts: ["cursor"] }), /ACL/);
    assert.deepEqual(tree(f.home), before);
  }
);

test("failure inspecting or securing a displaced file still rolls back the live write", async (t) => {
  for (const fault of ["permissions", ...(process.platform === "win32" ? [] : ["symlink"])]) {
    const f = fixture(t);
    const file = path.join(f.home, "config.json");
    put(file, "original");
    const policy = filePolicy();
    const secure = policy.secure;
    let armed = false;
    let injected = false;
    policy.secure = (target) => {
      if (armed && !injected && fault === "permissions") {
        injected = true;
        throw new Error("injected ACL failure");
      }
      secure(target);
    };
    await assert.rejects(
      commitHostFiles([{ source: policy.snapshot(file), bytes: Buffer.from("installer") }], {
        policy,
        atomicReplace: (...args) => {
          const displaced = atomicHostReplace(...args);
          armed = true;
          if (fault === "symlink" && !injected) {
            injected = true;
            fs.renameSync(displaced, displaced + ".preserved");
            fs.symlinkSync(displaced + ".preserved", displaced);
          }
          return displaced;
        },
      }),
      /ACL failure|regular/
    );
    assert.equal(fs.readFileSync(file, "utf8"), "original");
  }
});

test("exclusive-link cleanup failure tracks and rolls back the new live file", async (t) => {
  const f = fixture(t);
  const file = path.join(f.home, "new.json");
  const policy = filePolicy();
  const unlink = fs.unlinkSync;
  let injected = false;
  fs.unlinkSync = (target) => {
    if (!injected && String(target).endsWith(".tmp") && fs.existsSync(file)) {
      injected = true;
      throw new Error("injected temporary cleanup failure");
    }
    return unlink(target);
  };
  try {
    await assert.rejects(
      commitHostFiles([{ source: policy.snapshot(file), bytes: Buffer.from("installer") }], {
        policy,
      }),
      /temporary cleanup failure/
    );
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.unlinkSync = unlink;
  }
});

test("edits after an individual write fail the final transaction check", async (t) => {
  const f = fixture(t);
  const file = path.join(f.home, "config.json");
  put(file, "original");
  const policy = filePolicy();
  await assert.rejects(
    commitHostFiles([{ source: policy.snapshot(file), bytes: Buffer.from("installer") }], {
      policy,
      afterReplace: async () => put(file, "concurrent"),
    }),
    /Concurrent edit.*rollback conflicts/s
  );
  assert.equal(fs.readFileSync(file, "utf8"), "concurrent");
});

test("partial native replacement failure restores the displaced original exclusively", async (t) => {
  for (const concurrent of [false, true, "displaced"]) {
    const f = fixture(t);
    const file = path.join(f.home, "config.json");
    put(file, "original");
    const policy = filePolicy();
    await assert.rejects(
      commitHostFiles([{ source: policy.snapshot(file), bytes: Buffer.from("installer") }], {
        policy,
        atomicReplace: (_temporary, target, recovery) => {
          if (concurrent === "displaced") put(target, "concurrent");
          fs.renameSync(target, recovery);
          if (concurrent === true) put(target, "concurrent");
          throw new Error("native failure 1177");
        },
      }),
      /1177/
    );
    assert.equal(fs.readFileSync(file, "utf8"), concurrent ? "concurrent" : "original");
    if (concurrent === true)
      assert.ok(
        fs
          .readdirSync(f.home)
          .some(
            (name) =>
              name.includes("displaced") &&
              fs.readFileSync(path.join(f.home, name), "utf8") === "original"
          )
      );
  }
});

test(
  "non-private host files in shared project directories commit and roll back",
  {
    skip: process.platform === "win32",
  },
  async (t) => {
    const f = fixture(t);
    fs.chmodSync(f.project, 0o770);
    const file = path.join(f.project, ".mcp.json");
    put(file, "original");
    const policy = filePolicy();
    const result = await commitHostFiles(
      [{ source: policy.snapshot(file), bytes: Buffer.from("installed") }],
      { policy }
    );
    assert.equal(fs.readFileSync(file, "utf8"), "installed");
    for (const backup of result.backups) assert.equal(fs.statSync(backup).mode & 0o077, 0);
    assert.equal(fs.readdirSync(f.project).filter((name) => name.endsWith(".tmp")).length, 0);
    await assert.rejects(
      commitHostFiles([{ source: policy.snapshot(file), bytes: Buffer.from("replacement") }], {
        policy,
        beforeCommit: async () => {
          throw new Error("injected final failure");
        },
      }),
      (error) =>
        /injected final failure/.test(error.message) && !/rollback conflicts/.test(error.message)
    );
    assert.equal(fs.readFileSync(file, "utf8"), "installed");
  }
);

test(
  "Windows installer ACL and process checks resist cwd and PATH executable shadows",
  { skip: process.platform !== "win32" },
  async (t) => {
    const f = fixture(t);
    const file = path.join(f.home, "private.json");
    put(file, "synthetic");
    fs.copyFileSync(process.execPath, path.join(f.project, "powershell.exe"));
    const originalCwd = process.cwd();
    const originalPath = process.env.PATH;
    const originalNoCwd = process.env.NoDefaultCurrentDirectoryInExePath;
    try {
      delete process.env.NoDefaultCurrentDirectoryInExePath;
      for (const mode of ["cwd", "path"]) {
        process.chdir(mode === "cwd" ? f.project : f.home);
        process.env.PATH =
          mode === "path" ? f.project + path.delimiter + originalPath : originalPath;
        assert.equal(
          execFileSync("powershell.exe", ["-e", "process.stdout.write('shadow-control')"], {
            encoding: "utf8",
            timeout: 30000,
          }),
          "shadow-control"
        );
        filePolicy().secure(file);
        const acl = readWindowsHostAcls([file]).get(file);
        assert.equal(acl.owner, acl.current);
        assert.deepEqual(acl.allow, [acl.current]);
        assert.ok(runningHostNames().length > 0);
      }
    } finally {
      process.chdir(originalCwd);
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalNoCwd === undefined) delete process.env.NoDefaultCurrentDirectoryInExePath;
      else process.env.NoDefaultCurrentDirectoryInExePath = originalNoCwd;
    }
  }
);

// Exercise the installed reader with actual Windows PowerShell and NTFS ACLs.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

assert.equal(process.platform, "win32", "This acceptance check requires Windows");
const artifact = path.resolve(process.env.MCP_PACKAGE_ARTIFACT);
const candidate = JSON.parse(readFileSync(path.join(artifact, "candidate.json"), "utf8"));
const tarball = path.join(artifact, candidate.tarball);
assert.equal(createHash("sha256").update(readFileSync(tarball)).digest("hex"), candidate.sha256);
const scratch = mkdtempSync(path.join(tmpdir(), "mcp-windows-credentials-"));
const home = path.join(scratch, "home");
const directory = path.join(home, ".aios");
const file = path.join(directory, "credentials.json");
const powershell = (script, target) =>
  execFileSync(
    path.win32.join(
      process.env.SystemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe"
    ),
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$env:PSModulePath=$PSHOME+'\\Modules'; " + script,
    ],
    {
      encoding: "utf8",
      timeout: 30000,
      env: { ...process.env, MCP_ACL_TARGET: target },
      windowsHide: true,
    }
  );
const ownerOnly =
  "$ErrorActionPreference='Stop'; $p=$env:MCP_ACL_TARGET; " +
  "$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; " +
  "$acl=Get-Acl -LiteralPath $p; $acl.SetOwner($sid); " +
  "$acl.SetAccessRuleProtection($true,$false); " +
  "@($acl.Access) | ForEach-Object { [void]$acl.RemoveAccessRuleSpecific($_) }; " +
  "$rule=[System.Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','Allow'); " +
  "$acl.AddAccessRule($rule); Set-Acl -LiteralPath $p -AclObject $acl";
try {
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(scratch, "package.json"), '{"private":true}');
  // npm's JS entry avoids shell interpretation of the tarball path on Windows.
  const npmCli = path.join(
    path.dirname(process.execPath),
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js"
  );
  execFileSync(
    process.execPath,
    [npmCli, "install", tarball, "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: scratch, stdio: "pipe" }
  );
  const installed = path.join(scratch, "node_modules", "@aiosbrain", "mcp");
  const { readGlobalCredential, readWindowsCredentialAcl } = await import(
    pathToFileURL(path.join(installed, "lib", "scripts", "mcp-credentials.mjs"))
  );
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      default: {
        brain_url: "https://brain.example.com",
        api_key: "test-win-key",
      },
    })
  );
  powershell(ownerOnly, file);
  powershell(ownerOnly, directory);
  for (const target of [directory, file]) {
    const acl = readWindowsCredentialAcl(target);
    assert.deepEqual(acl.allow, [acl.current], "A single native ACE must remain a JSON array");
  }
  assert.equal(readGlobalCredential({ home }).api_key, "test-win-key");
  // A renamed Node executable is a harmless control for Windows executable lookup.
  // Exercise both project cwd and PATH shadowing against the installed tarball.
  const shadow = path.join(scratch, "untrusted-project");
  mkdirSync(shadow);
  copyFileSync(process.execPath, path.join(shadow, "powershell.exe"));
  const originalCwd = process.cwd();
  const originalPath = process.env.PATH;
  const originalNoCwd = process.env.NoDefaultCurrentDirectoryInExePath;
  try {
    delete process.env.NoDefaultCurrentDirectoryInExePath;
    for (const mode of ["cwd", "path"]) {
      process.chdir(mode === "cwd" ? shadow : home);
      process.env.PATH = mode === "path" ? shadow + path.delimiter + originalPath : originalPath;
      const control = execFileSync(
        "powershell.exe",
        ["-e", "process.stdout.write('shadow-control')"],
        { encoding: "utf8", timeout: 30000, windowsHide: true }
      );
      assert.equal(
        control,
        "shadow-control",
        `Legacy ${mode} lookup must execute the shadow control`
      );
      assert.equal(
        readGlobalCredential({ home }).api_key,
        "test-win-key",
        `Installed reader must use actual system PowerShell despite ${mode} shadowing`
      );
    }
  } finally {
    process.chdir(originalCwd);
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalNoCwd === undefined) delete process.env.NoDefaultCurrentDirectoryInExePath;
    else process.env.NoDefaultCurrentDirectoryInExePath = originalNoCwd;
  }
  console.log("Installed Windows reader: cwd and PATH executable-shadow controls passed");
  const grantEveryone =
    "$ErrorActionPreference='Stop'; $p=$env:MCP_ACL_TARGET; $acl=Get-Acl -LiteralPath $p; " +
    "$sid=[System.Security.Principal.SecurityIdentifier]::new('S-1-1-0'); " +
    "$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid,'Read','Allow')); " +
    "Set-Acl -LiteralPath $p -AclObject $acl";
  for (const target of [file, directory]) {
    powershell(grantEveryone, target);
    assert.throws(() => readGlobalCredential({ home }), /another principal/);
    powershell(ownerOnly, target);
  }
  assert.equal(readGlobalCredential({ home }).api_key, "test-win-key");
  console.log("Installed Windows credential reader: owner-only and broad ACL controls passed");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

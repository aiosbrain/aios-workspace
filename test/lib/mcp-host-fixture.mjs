import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { windowsSystemExecutable } from "../../scripts/mcp-credentials.mjs";
export const credential = {
  brain_url: "https://brain.example",
  api_key: "test-key",
  team_id: "synthetic",
};
export const fetchImpl = async () => ({
  ok: true,
  json: async () => ({ tier: "team", actor: "synthetic", role: "member", team: "synthetic" }),
});
function fixtureOwner(file) {
  if (process.platform !== "win32") return;
  // Elevated Windows CI creates files owned by Administrators by default. These
  // fixtures model an explicitly user-owned home; do not relax production checks.
  const script =
    "$ErrorActionPreference='Stop'; $env:PSModulePath=$PSHOME+'\\Modules'; $p=$env:AIOS_TEST_OWNER_PATH; $a=Get-Acl -LiteralPath $p; $a.SetOwner([System.Security.Principal.WindowsIdentity]::GetCurrent().User); Set-Acl -LiteralPath $p -AclObject $a";
  execFileSync(
    windowsSystemExecutable("powershell"),
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      env: { ...process.env, AIOS_TEST_OWNER_PATH: file },
      stdio: "pipe",
      timeout: 5000,
    }
  );
}
export function fixture(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-host-test-")));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const project = path.join(home, "project");
  fs.mkdirSync(project);
  fixtureOwner(home);
  fixtureOwner(project);
  return {
    home,
    project,
    platform: process.platform === "win32" ? "win32" : "darwin",
    // Keep the OS installation path needed by the real Windows credential reader.
    // Do not inherit ambient Brain credentials into synthetic acceptance launches.
    env: process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {},
    credential,
    fetchImpl,
    runningHosts: () => [],
    command: { command: process.execPath, args: ["synthetic-mcp-driver"] },
    verify: async () => ({ verified: true, tools: ["synthetic"] }),
  };
}
export function put(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, text, { mode: 0o600 });
  if (process.platform === "win32") {
    fixtureOwner(file);
    for (let dir = path.dirname(file); dir.includes("mcp-host-test-"); dir = path.dirname(dir))
      fixtureOwner(dir);
  }
}
export function tree(root) {
  const rows = {};
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      const s = fs.lstatSync(file);
      rows[file] = [
        s.mtimeMs,
        s.mode,
        entry.isDirectory() ? "directory" : fs.readFileSync(file).toString("base64"),
      ];
      if (entry.isDirectory()) walk(file);
    }
  }
  walk(root);
  return rows;
}

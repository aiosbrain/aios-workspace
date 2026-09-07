// Shared default credential reader. Never print or return credentials in diagnostics.
import { constants, lstatSync, openSync, fstatSync, readFileSync, closeSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { homedir } from "node:os";
import { normalizeBrainOriginFromConfig } from "../packages/foundation/src/internal/brain-origin.mjs";

export function assertWindowsCredentialAcl(acl) {
  if (!acl || acl.owner !== acl.current || !Array.isArray(acl.allow))
    throw new Error("Credential ownership could not be verified");
  const trusted = new Set([acl.current, "S-1-5-18", "S-1-5-32-544"]);
  if (acl.allow.some((sid) => !trusted.has(sid)))
    throw new Error("Credential ACL grants access to another principal");
  if (!acl.allow.includes(acl.current))
    throw new Error("Credential ACL does not grant the owner access");
}

export function readWindowsCredentialAcl(file, exec = execFileSync) {
  // The path is passed as an environment value, never interpolated into PowerShell code.
  const script =
    "$ErrorActionPreference='Stop'; $a=Get-Acl -LiteralPath $env:AIOS_CREDENTIAL_ACL_PATH; " +
    "$current=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; " +
    "$owner=([System.Security.Principal.NTAccount]$a.Owner).Translate([System.Security.Principal.SecurityIdentifier]).Value; " +
    "$allow=@($a.Access | Where-Object {$_.AccessControlType -eq 'Allow'} | ForEach-Object {$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value}); " +
    "@{owner=$owner;current=$current;allow=$allow} | ConvertTo-Json -Compress";
  return JSON.parse(
    exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: { ...process.env, AIOS_CREDENTIAL_ACL_PATH: file },
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    })
  );
}

export function validateCredentialTuple(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid default Brain credential tuple");
  const allowed = new Set(["brain_url", "api_key", "team_id", "member"]);
  if (Object.keys(value).some((key) => !allowed.has(key)))
    throw new Error("Unknown default Brain credential field");
  for (const key of ["brain_url", "api_key"]) {
    if (typeof value[key] !== "string" || !value[key].trim() || /[\r\n]/.test(value[key]))
      throw new Error(`Invalid credential field: ${key}`);
  }
  for (const key of ["team_id", "member"]) {
    if (value[key] !== undefined && (typeof value[key] !== "string" || /[\r\n]/.test(value[key])))
      throw new Error(`Invalid credential field: ${key}`);
  }
  return {
    brain_url: normalizeBrainOriginFromConfig(value.brain_url),
    api_key: value.api_key,
    team_id: value.team_id || "",
    member: value.member || "",
  };
}

export function readGlobalCredential({
  home = homedir(),
  platform = process.platform,
  uid = process.getuid?.(),
  readAcl = readWindowsCredentialAcl,
} = {}) {
  const file = path.join(home, ".aios", "credentials.json");
  let before;
  try {
    before = lstatSync(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const directory = lstatSync(path.dirname(file));
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    directory.isSymbolicLink() ||
    !directory.isDirectory()
  )
    throw new Error("Credential path must be a regular file in a real directory");
  if (before.size > 65536) throw new Error("Credential file is too large");
  const check = (stat) => {
    if (platform === "win32") assertWindowsCredentialAcl(readAcl(file));
    else if (
      uid === undefined ||
      stat.uid !== uid ||
      directory.uid !== uid ||
      (stat.mode & 0o077) !== 0 ||
      (directory.mode & 0o022) !== 0
    ) {
      throw new Error(
        "Credential file must be owner-only (chmod 600), in an owner-controlled directory"
      );
    }
  };
  if (platform === "win32") assertWindowsCredentialAcl(readAcl(path.dirname(file)));
  check(before);
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = fstatSync(fd);
    if (opened.ino !== before.ino || opened.dev !== before.dev)
      throw new Error("Credential file changed while opening");
    check(opened);
    const text = readFileSync(fd, "utf8");
    const after = lstatSync(file);
    if (
      after.isSymbolicLink() ||
      after.ino !== opened.ino ||
      after.dev !== opened.dev ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs
    )
      throw new Error("Credential file changed while reading");
    let document;
    try {
      document = JSON.parse(text);
    } catch {
      throw new Error("Credential file is malformed JSON");
    }
    if (
      document?.version !== 1 ||
      !document.default ||
      Object.keys(document).some((key) => !["version", "default"].includes(key))
    )
      throw new Error("Unsupported credential file format");
    return {
      ...validateCredentialTuple(document.default),
      credential_source: "global-file",
      credential_file: file,
    };
  } finally {
    closeSync(fd);
  }
}

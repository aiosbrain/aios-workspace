import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { assertWindowsCredentialAcl, readWindowsCredentialAcl } from "./mcp-credentials.mjs";

const sameIdentity = (a, b) => a && b && a.dev === b.dev && a.ino === b.ino;
function stat(file) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export function filePolicy({
  platform = process.platform,
  uid = process.getuid?.(),
  readAcl = readWindowsCredentialAcl,
  exec = execFileSync,
} = {}) {
  function owner(file, value, privateFile = false) {
    if (platform === "win32") {
      const acl = readAcl(file);
      if (acl.owner !== acl.current) throw new Error(`Foreign ownership: ${file}`);
      if (privateFile) assertWindowsCredentialAcl(acl);
    } else if (uid === undefined || value.uid !== uid || (privateFile && value.mode & 0o077))
      throw new Error(`Unsafe ownership or permissions: ${file}`);
  }
  function secure(file) {
    if (platform !== "win32") fs.chmodSync(file, 0o600);
    else {
      const script =
        "$ErrorActionPreference='Stop'; $env:PSModulePath=$PSHOME+'\\Modules'; " +
        "$p=$env:AIOS_MCP_PRIVATE_PATH; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; " +
        "$a=Get-Acl -LiteralPath $p; $a.SetAccessRuleProtection($true,$false); " +
        "foreach($r in @($a.Access)){$a.RemoveAccessRuleSpecific($r)}; $a.SetOwner($sid); " +
        "$rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow'); " +
        "$a.AddAccessRule($rule); Set-Acl -LiteralPath $p -AclObject $a";
      exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        env: { ...process.env, AIOS_MCP_PRIVATE_PATH: file },
        windowsHide: true,
        timeout: 5000,
        stdio: "pipe",
      });
    }
    owner(file, fs.lstatSync(file), true);
  }
  function parents(file) {
    const found = [];
    for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
      const value = stat(dir);
      if (value) {
        if (value.isSymbolicLink() || !value.isDirectory())
          throw new Error(`Unsafe directory: ${dir}`);
        found.push({ file: dir, value });
      }
      if (dir === path.dirname(dir)) break;
    }
    if (!found.length) throw new Error(`No safe parent directory: ${file}`);
    owner(found[0].file, found[0].value);
    return found;
  }
  function snapshot(file, { privateFile = false } = {}) {
    const directories = parents(file);
    const before = stat(file);
    if (!before) return { file, bytes: null, value: null, directories, privateFile };
    if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1)
      throw new Error(`Not a regular unlinked file: ${file}`);
    if (before.size > 4 * 1024 * 1024) throw new Error(`Configuration file is too large: ${file}`);
    owner(file, before, privateFile);
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    let bytes;
    try {
      const opened = fs.fstatSync(fd);
      if (!sameIdentity(before, opened)) throw new Error(`File changed while opening: ${file}`);
      bytes = fs.readFileSync(fd);
      const after = fs.fstatSync(fd);
      if (
        after.size !== opened.size ||
        after.mtimeMs !== opened.mtimeMs ||
        !sameIdentity(after, stat(file))
      )
        throw new Error(`File changed while reading: ${file}`);
    } finally {
      fs.closeSync(fd);
    }
    return { file, bytes, value: before, directories, privateFile };
  }
  function recheck(source) {
    for (const dir of source.directories) {
      const current = stat(dir.file);
      if (!current || current.isSymbolicLink() || !sameIdentity(dir.value, current))
        throw new Error(`Directory changed: ${dir.file}`);
    }
    const current = snapshot(source.file, { privateFile: source.privateFile });
    if (
      (source.value === null) !== (current.value === null) ||
      (source.value && !sameIdentity(source.value, current.value)) ||
      (source.bytes !== null && !source.bytes.equals(current.bytes))
    )
      throw new Error(`Concurrent edit: ${source.file}`);
  }
  function writable(source) {
    fs.accessSync(source.directories[0].file, fs.constants.W_OK | fs.constants.X_OK);
  }
  return { owner, secure, snapshot, recheck, writable, platform };
}

// All targets are preflighted before this transaction is called. Rollback refuses to
// overwrite any file that no longer has both the identity and bytes we wrote.
export async function commitHostFiles(
  changes,
  { policy = filePolicy(), beforeReplace = async () => {}, afterReplace = async () => {} } = {}
) {
  const applied = [],
    createdDirs = [],
    backups = [];
  function createParents(file) {
    const missing = [];
    for (let dir = path.dirname(file); !stat(dir); dir = path.dirname(dir)) missing.unshift(dir);
    for (const dir of missing) {
      fs.mkdirSync(dir, { mode: 0o700 });
      createdDirs.push({ file: dir, value: fs.lstatSync(dir) });
      if (policy.platform === "win32") policy.secure(dir);
    }
  }
  function privateWrite(file, bytes) {
    const fd = fs.openSync(
      file,
      fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_WRONLY |
        (fs.constants.O_NOFOLLOW || 0),
      0o600
    );
    try {
      policy.secure(file);
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
  function replace(source, bytes) {
    const temporary = path.join(
      path.dirname(source.file),
      `.${path.basename(source.file)}.aios-${randomUUID()}.tmp`
    );
    try {
      privateWrite(temporary, bytes);
      const value = fs.lstatSync(temporary);
      policy.recheck(source);
      fs.renameSync(temporary, source.file);
      return { ...source, bytes, value, privateFile: true };
    } finally {
      if (stat(temporary)) fs.unlinkSync(temporary);
    }
  }
  try {
    for (const change of changes) policy.recheck(change.source);
    for (const change of changes) {
      if (change.source.bytes?.equals(change.bytes)) continue;
      policy.recheck(change.source);
      createParents(change.source.file);
      // Capture newly created parent identities as well as the original chain.
      const source = policy.snapshot(change.source.file, {
        privateFile: change.source.privateFile,
      });
      policy.recheck(change.source);
      if (source.bytes !== null) {
        const backup = `${source.file}.aios-backup-${randomUUID()}`;
        privateWrite(backup, source.bytes);
        backups.push(backup);
      }
      await beforeReplace(source.file);
      const written = replace(source, change.bytes);
      applied.push({ source, written });
      policy.recheck(written);
      await afterReplace(source.file);
    }
    return { backups };
  } catch (error) {
    const conflicts = [];
    for (const { source, written } of applied.reverse()) {
      try {
        policy.recheck(written);
        if (source.bytes === null) fs.unlinkSync(source.file);
        else replace(written, source.bytes);
      } catch {
        conflicts.push(source.file);
      }
    }
    for (const dir of createdDirs.reverse()) {
      try {
        if (sameIdentity(dir.value, stat(dir.file))) fs.rmdirSync(dir.file);
      } catch {
        /* May hold restrictive recovery backups. */
      }
    }
    throw new Error(
      `MCP installation failed: ${error.message}${conflicts.length ? `; rollback conflicts (preserved): ${conflicts.join(", ")}` : "; previous file contents restored"}`,
      { cause: error }
    );
  }
}

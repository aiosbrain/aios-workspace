import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readWindowsHostAcls } from "./mcp-host-acl.mjs";
import { atomicHostReplace } from "./mcp-host-atomic.mjs";
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
  function owner(file, value, privateFile = false, aclValue) {
    if (platform === "win32") {
      const acl = aclValue || readAcl(file);
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
    return found;
  }
  function snapshot(file, { privateFile = false, privateDirectories = privateFile } = {}) {
    const directories = parents(file);
    const before = stat(file);
    const aclPaths = [...directories.map((dir) => dir.file), ...(before ? [file] : [])];
    const acls =
      platform === "win32"
        ? readAcl === readWindowsCredentialAcl
          ? readWindowsHostAcls(aclPaths, exec)
          : new Map(aclPaths.map((name) => [name, readAcl(name)]))
        : new Map();
    owner(directories[0].file, directories[0].value, false, acls.get(directories[0].file));
    if (privateDirectories) {
      // Every user-controlled ancestor must resist replacement by another
      // principal, including ancestors above an existing package subdirectory.
      for (const dir of directories) {
        if (platform === "win32") {
          const acl = acls.get(dir.file);
          if (acl.owner !== acl.current) break;
          assertWindowsCredentialAcl(acl);
        } else {
          if (dir.value.uid !== uid) break;
          if (dir.value.mode & 0o022)
            throw new Error(
              `Private configuration directory is writable by another principal: ${dir.file}`
            );
        }
      }
    }
    if (!before)
      return { file, bytes: null, value: null, directories, privateFile, privateDirectories };
    if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1)
      throw new Error(`Not a regular unlinked file: ${file}`);
    if (before.size > 4 * 1024 * 1024) throw new Error(`Configuration file is too large: ${file}`);
    owner(file, before, privateFile, acls.get(file));
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
    return { file, bytes, value: before, directories, privateFile, privateDirectories };
  }
  function recheck(source) {
    for (const dir of source.directories) {
      const current = stat(dir.file);
      if (!current || current.isSymbolicLink() || !sameIdentity(dir.value, current))
        throw new Error(`Directory changed: ${dir.file}`);
    }
    const current = snapshot(source.file, {
      privateFile: source.privateFile,
      privateDirectories: source.privateDirectories,
    });
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
  {
    policy = filePolicy(),
    beforeReplace = async () => {},
    afterReplace = async () => {},
    beforeCommit = async () => {},
    atomicReplace = atomicHostReplace,
  } = {}
) {
  const applied = [],
    createdDirs = [],
    backups = [],
    recoveries = [];
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
  function replace(source, bytes, onInstalled = () => {}) {
    const temporary = path.join(
      path.dirname(source.file),
      `.${path.basename(source.file)}.aios-${randomUUID()}.tmp`
    );
    const recovery = `${source.file}.aios-displaced-${randomUUID()}`;
    privateWrite(temporary, bytes);
    const value = fs.lstatSync(temporary);
    let displaced;
    try {
      policy.recheck(source);
      displaced = atomicReplace(temporary, source.file, recovery, source.value !== null);
    } catch (error) {
      // ReplaceFileW error 1177 may move the old target to recovery without
      // installing the new target. Restore only the verified displaced original
      // into an absent name; exclusive creation preserves any intervening writer.
      if (!stat(source.file) && stat(recovery)) {
        try {
          policy.snapshot(recovery);
          fs.linkSync(recovery, source.file);
          fs.unlinkSync(recovery);
        } catch {
          /* Recovery paths below explain unresolved OS/concurrent failures. */
        }
      }
      // Discard only the verified unused installer temporary; retain displaced
      // originals or any changed recovery object for the user.
      try {
        const unused = policy.snapshot(temporary);
        if (sameIdentity(value, unused.value) && bytes.equals(unused.bytes))
          fs.unlinkSync(temporary);
      } catch {
        /* Report any remaining recovery below. */
      }
      // Preserve all remaining names; never guess which inode the OS moved.
      for (const file of [temporary, recovery]) if (stat(file)) recoveries.push({ file });
      throw error;
    }
    const written = { ...source, bytes, value };
    const tracked = { source, written };
    onInstalled(tracked);
    if (!displaced) {
      // The exclusive link is already a live write. Track it before cleanup,
      // which can fail independently (for example, a Windows file scanner).
      try {
        fs.unlinkSync(temporary);
      } catch (error) {
        recoveries.push({ file: temporary });
        try {
          fs.unlinkSync(temporary);
        } catch {
          /* Rollback will report a conflict. */
        }
        throw error;
      }
    }
    let original = null;
    if (displaced) {
      recoveries.push({ file: displaced });
      original = policy.snapshot(displaced);
      tracked.source = { ...source, bytes: original.bytes };
      policy.secure(displaced);
      recoveries.at(-1).snapshot = policy.snapshot(displaced, {
        privateFile: true,
        privateDirectories: source.privateFile,
      });
    }
    return { written, original };
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
      const { written, original } = replace(source, change.bytes, (entry) => applied.push(entry));
      if (
        original &&
        (!sameIdentity(source.value, original.value) || !source.bytes.equals(original.bytes))
      )
        throw new Error(`Concurrent edit at atomic replacement: ${source.file}`);
      policy.recheck(written);
      await afterReplace(source.file);
    }
    await beforeCommit();
    for (const { written } of applied) policy.recheck(written);
    for (const recovery of recoveries) if (recovery.snapshot) policy.recheck(recovery.snapshot);
    for (const recovery of recoveries) fs.unlinkSync(recovery.file);
    return { backups };
  } catch (error) {
    const conflicts = [];
    for (const { source, written } of applied.reverse()) {
      try {
        policy.recheck(written);
        if (source.bytes === null) {
          const removed = `${source.file}.aios-rollback-${randomUUID()}`;
          fs.renameSync(source.file, removed);
          recoveries.push({ file: removed });
          const actual = policy.snapshot(removed);
          if (!sameIdentity(written.value, actual.value) || !written.bytes.equals(actual.bytes)) {
            try {
              fs.linkSync(removed, source.file);
            } catch {
              /* Preserve both concurrent names. */
            }
            throw new Error("Concurrent edit during rollback removal");
          }
          fs.unlinkSync(removed);
        } else {
          const restored = replace(written, source.bytes);
          if (
            restored.original &&
            (!sameIdentity(written.value, restored.original.value) ||
              !written.bytes.equals(restored.original.bytes))
          )
            throw new Error("Concurrent edit during rollback");
        }
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
      `MCP installation failed: ${error.message}${
        recoveries.some((row) => stat(row.file))
          ? `; recovery files preserved: ${recoveries
              .filter((row) => stat(row.file))
              .map((row) => row.file)
              .join(", ")}`
          : ""
      }${conflicts.length ? `; rollback conflicts (preserved): ${conflicts.join(", ")}` : "; rollback completed for tracked unchanged writes"}`,
      { cause: error }
    );
  }
}

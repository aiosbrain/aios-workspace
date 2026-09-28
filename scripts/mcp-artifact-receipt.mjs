// Builtin-only launch verification shared by both installed profile servers.
import { createHash } from "node:crypto";
import { readFileSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import {
  readPrivateDocument,
  readWindowsCredentialAcl,
  assertWindowsCredentialAcl,
} from "./mcp-credentials.mjs";
import { deny } from "./mcp-profile-schema.mjs";
export function verifyProfileArtifactReceipt(file, options = {}) {
  try {
    const receipt = readPrivateDocument(file, options);
    if (
      receipt.version !== 1 ||
      !["@aiosbrain/mcp", "@aiosbrain/aios"].includes(receipt.packageName) ||
      !/^sha512-[A-Za-z0-9+/]+=*$/.test(receipt.integrity) ||
      !path.isAbsolute(receipt.packageRoot) ||
      realpathSync(receipt.packageRoot) !== receipt.packageRoot
    )
      deny("UNAVAILABLE");
    const receiptRoot = realpathSync(path.dirname(file));
    const relation = path.relative(receiptRoot, receipt.packageRoot);
    if (path.isAbsolute(relation) || relation.split(path.sep).includes("..")) deny("UNAVAILABLE");
    const platform = options.platform || process.platform;
    const uid = options.uid ?? process.getuid?.();
    const readAcl = options.readAcl || readWindowsCredentialAcl;
    const checked = new Set();
    function inspect(target, isFile = false) {
      for (let at = target; ; at = path.dirname(at)) {
        if (checked.has(at)) break;
        const stat = lstatSync(at);
        if (
          stat.isSymbolicLink() ||
          realpathSync(at) !== at ||
          (at === target && isFile ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory())
        )
          deny("UNAVAILABLE");
        if (platform === "win32") assertWindowsCredentialAcl(readAcl(at));
        else if (uid === undefined || stat.uid !== uid || stat.mode & 0o022) deny("UNAVAILABLE");
        checked.add(at);
        if (at === receiptRoot) break;
      }
    }
    inspect(receipt.packageRoot);
    for (const [relative, expected] of Object.entries(receipt.hashes)) {
      if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).includes(".."))
        deny("UNAVAILABLE");
      const target = path.join(receipt.packageRoot, relative);
      inspect(target, true);
      if (createHash("sha256").update(readFileSync(target)).digest("hex") !== expected)
        deny("UNAVAILABLE");
    }
    if (!receipt.hashes["package.json"] || !receipt.hashes[receipt.entrypoint]) deny("UNAVAILABLE");
    const manifest = JSON.parse(
      readFileSync(path.join(receipt.packageRoot, "package.json"), "utf8")
    );
    if (manifest.name !== receipt.packageName || manifest.version !== receipt.packageVersion)
      deny("UNAVAILABLE");
    return receipt;
  } catch {
    deny(
      "UNAVAILABLE",
      "The installed profile artifact changed or is unsafe. Reinstall its verified version."
    );
  }
}

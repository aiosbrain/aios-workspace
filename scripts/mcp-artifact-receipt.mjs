// Builtin-only launch verification shared by both installed profile servers.
import { createHash } from "node:crypto";
import { readFileSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { readPrivateDocument } from "./mcp-credentials.mjs";
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
    const root = lstatSync(receipt.packageRoot);
    if (
      !root.isDirectory() ||
      root.isSymbolicLink() ||
      (process.platform !== "win32" && (root.uid !== process.getuid?.() || root.mode & 0o022))
    )
      deny("UNAVAILABLE");
    for (const [relative, expected] of Object.entries(receipt.hashes)) {
      if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).includes(".."))
        deny("UNAVAILABLE");
      const target = path.join(receipt.packageRoot, relative),
        stat = lstatSync(target);
      if (
        (process.platform !== "win32" && (stat.uid !== process.getuid?.() || stat.mode & 0o022)) ||
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        realpathSync(target) !== target ||
        createHash("sha256").update(readFileSync(target)).digest("hex") !== expected
      )
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

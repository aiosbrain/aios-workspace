import path from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { UpdateError } from "../cli-common.mjs";

const PACKAGE = "@aiosbrain/aios";
const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
};

/** Bind npm operations to the package root actually selected, including custom prefixes. */
export function npmInstallation(root) {
  if (!root || !path.isAbsolute(root)) return null;
  const packageRoot = real(root);
  if (!packageRoot) return null;
  try {
    const globalRoot = execFileSync("npm", ["root", "-g"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (path.isAbsolute(globalRoot) && real(path.join(globalRoot, PACKAGE)) === packageRoot) {
      const prefix = execFileSync("npm", ["prefix", "-g"], {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (
        path.isAbsolute(prefix) &&
        real(path.join(prefix, "lib", "node_modules", PACKAGE)) === packageRoot
      ) {
        return { method: "global", prefix: real(prefix), root: packageRoot };
      }
    }
  } catch {
    /* A local installation can still be identified without a global npm configuration. */
  }
  const prefix = path.resolve(packageRoot, "..", "..", "..");
  if (
    real(path.join(prefix, "node_modules", PACKAGE)) === packageRoot &&
    existsSync(path.join(prefix, "package.json"))
  ) {
    return { method: "local", prefix, root: packageRoot };
  }
  return null;
}

export function npmReinstallArgs(installation, version) {
  if (
    !installation ||
    !["local", "global"].includes(installation.method) ||
    !path.isAbsolute(installation.prefix) ||
    !path.isAbsolute(installation.root)
  ) {
    throw new UpdateError(
      "The prior npm installation is not identified; restore the exact package at its recorded source manually."
    );
  }
  return [
    "i",
    ...(installation.method === "global" ? ["-g"] : []),
    "--prefix",
    installation.prefix,
    `${PACKAGE}@${version}`,
  ];
}

export function upgradeInvokedInstallation(root) {
  if (root?.kind !== "registry")
    throw new UpdateError(
      "aios update --self upgrades a registry (npm) install; update a checkout with git pull / aios update there."
    );
  const installation = npmInstallation(root.dir);
  if (!installation)
    throw new UpdateError(
      "This registry directory is not an identified npm installation. Install the package through npm before using --self."
    );
  const res = spawnSync("npm", npmReinstallArgs(installation, "latest"), { stdio: "inherit" });
  if (res.error) throw new UpdateError(`couldn't run npm (${res.error.message})`);
  return res.status ?? 1;
}

import path from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
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
  // npm's default prefix need not own this executable (e.g. --prefix /custom).
  // Validate both the global layout and npm's executable link at the selected root.
  const globalPrefix = path.resolve(packageRoot, "..", "..", "..", "..");
  if (
    real(path.join(globalPrefix, "lib", "node_modules", PACKAGE)) === packageRoot &&
    real(path.join(globalPrefix, "bin", "aios")) ===
      real(path.join(packageRoot, "scripts", "aios.mjs")) &&
    real(path.join(packageRoot, "scripts", "aios.mjs")) !== null
  ) {
    return { method: "global", prefix: globalPrefix, root: packageRoot };
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

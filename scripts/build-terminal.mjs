import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { terminalFingerprint, writeTerminalStamp } from "./ensure-terminal-built.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const dist = path.join(root, "dist");
const live = path.join(dist, "terminal");
// Compile into a private staging directory and swap it in whole, so a command importing
// dist/terminal while another builds sees the old build or the new one, never a torn mix.
const staging = path.join(dist, `.terminal-staging-${process.pid}`);
const retired = path.join(dist, `.terminal-retired-${process.pid}`);

/** Replace dist/terminal with `staging`: two renames, or a copy where renames are refused. */
function publish() {
  let moved = false;
  try {
    if (existsSync(live)) {
      renameSync(live, retired);
      moved = true;
    }
    renameSync(staging, live);
  } catch {
    // Windows can refuse a directory rename while a scanner holds a handle: fall back to
    // the pre-staging behaviour (overwrite in place) rather than failing the build.
    if (moved && !existsSync(live)) renameSync(retired, live);
    cpSync(staging, live, { recursive: true, force: true });
  } finally {
    rmSync(retired, { recursive: true, force: true });
  }
}

// Fingerprint the inputs BEFORE compiling: an edit made mid-compile then reads as stale.
const fingerprint = terminalFingerprint(root);
rmSync(staging, { recursive: true, force: true });
try {
  execFileSync(
    process.execPath,
    [
      "node_modules/typescript/bin/tsc",
      "-p",
      "tsconfig.terminal.json",
      "--noEmitOnError",
      "--outDir",
      staging,
    ],
    { cwd: root, stdio: "inherit" }
  );
  mkdirSync(path.join(staging, "vendor"), { recursive: true });
  for (const file of ["LICENSE", "provenance.json"])
    copyFileSync(
      path.join(root, "src", "terminal", "vendor", file),
      path.join(staging, "vendor", file)
    );
  // The stamp lets scripts/ensure-terminal-built.mjs prove this build is current.
  writeTerminalStamp(root, fingerprint, staging);
  publish();
} finally {
  rmSync(staging, { recursive: true, force: true });
}

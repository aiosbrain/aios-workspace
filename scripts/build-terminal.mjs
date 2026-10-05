import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { terminalFingerprint, writeTerminalStamp } from "./ensure-terminal-built.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
// Fingerprint the inputs BEFORE compiling: an edit made mid-compile then reads as stale.
const fingerprint = terminalFingerprint(root);
execFileSync(
  process.execPath,
  ["node_modules/typescript/bin/tsc", "-p", "tsconfig.terminal.json", "--noEmitOnError"],
  { cwd: root, stdio: "inherit" }
);
mkdirSync(new URL("../dist/terminal/vendor/", import.meta.url), { recursive: true });
for (const file of ["LICENSE", "provenance.json"])
  copyFileSync(
    new URL(`../src/terminal/vendor/${file}`, import.meta.url),
    new URL(`../dist/terminal/vendor/${file}`, import.meta.url)
  );
// The stamp lets scripts/ensure-terminal-built.mjs prove this build is current.
writeTerminalStamp(root, fingerprint);

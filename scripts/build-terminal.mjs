import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
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

#!/usr/bin/env node
// Routing delegate ONLY (AIO-1067) — the Linear implementation lives in the aios CLI's
// built-in adapter (aios-workspace scripts/connectors/linear/). This file carries NO
// provider client and resolves NO credentials itself; it forwards every invocation to
// `aios linear <verb> …`, which owns credential resolution (`aios connect linear`).
// stdout and the exit status are the canonical command's; this warning is stderr-only.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.stderr.write(
  "aios-linear skill delegate: deprecated entry point — use `aios linear " +
    `${process.argv[2] ?? "<verb>"} …\` directly\n`
);

const here = path.dirname(fileURLToPath(import.meta.url));
// <workspace-or-toolkit>/scripts/aios.mjs (3 up), or the toolkit root when this copy lives
// under scaffold/ (4 up). In a scaffolded workspace, scripts/aios.mjs is the delegating
// shim that forwards to the canonical toolkit checkout.
const candidates = [
  path.resolve(here, "..", "..", "..", "scripts", "aios.mjs"),
  path.resolve(here, "..", "..", "..", "..", "scripts", "aios.mjs"),
];
const cli = candidates.find((candidate) => existsSync(candidate));
const argv = ["linear", ...process.argv.slice(2)];
const result = cli
  ? spawnSync(process.execPath, [cli, ...argv], { stdio: "inherit" })
  : spawnSync("aios", argv, { stdio: "inherit" });
if (result.error) {
  console.error(`aios-linear delegate: could not run the aios CLI: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);

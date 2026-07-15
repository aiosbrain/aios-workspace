#!/usr/bin/env node
// run-gui.mjs — build the current client, then start the GUI server.
import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function buildGuiClient({ root = ROOT, run = execFileSync } = {}) {
  console.log("building GUI client…");
  run("npm", ["run", "build", "--workspace", "gui/client"], {
    cwd: root,
    stdio: "inherit",
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildGuiClient();
  const child = spawn(
    process.execPath,
    [path.join(ROOT, "gui", "server", "index.mjs"), ...process.argv.slice(2)],
    { stdio: "inherit" }
  );
  child.on("exit", (code) => process.exit(code ?? 0));
}

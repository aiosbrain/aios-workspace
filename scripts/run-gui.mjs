#!/usr/bin/env node
// run-gui.mjs — build the client if needed, then start the GUI server.
import { existsSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(ROOT, "gui", "client", "dist");

if (!existsSync(path.join(dist, "index.html"))) {
  console.log("building GUI client (first run)…");
  execFileSync("npm", ["run", "build", "--workspace", "gui/client"], {
    cwd: ROOT,
    stdio: "inherit",
  });
}

const child = spawn(
  process.execPath,
  [path.join(ROOT, "gui", "server", "index.mjs"), ...process.argv.slice(2)],
  { stdio: "inherit" }
);
child.on("exit", (code) => process.exit(code ?? 0));

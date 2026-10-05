// Shared fixtures for test/terminal-autobuild*.test.mjs: throwaway source checkouts of the
// terminal presentation, with the real node_modules linked in.
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../../", import.meta.url));
const temps = [];
process.on("exit", () => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
export const tmp = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "aios-terminal-build-"));
  temps.push(dir);
  return dir;
};

/** A minimal source checkout: terminal sources, build config, and the real node_modules. */
export function checkout({ compiler = true } = {}) {
  const dir = tmp();
  cpSync(path.join(root, "src", "terminal"), path.join(dir, "src", "terminal"), {
    recursive: true,
  });
  mkdirSync(path.join(dir, "scripts"));
  for (const file of [
    "tsconfig.json",
    "tsconfig.terminal.json",
    "scripts/build-terminal.mjs",
    "scripts/ensure-terminal-built.mjs",
  ])
    cpSync(path.join(root, file), path.join(dir, file));
  writeFileSync(path.join(dir, "package.json"), '{ "type": "module" }\n');
  // A junction needs no privileges on Windows; elsewhere the type argument is ignored.
  if (compiler)
    symlinkSync(
      path.join(root, "node_modules"),
      path.join(dir, "node_modules"),
      process.platform === "win32" ? "junction" : "dir"
    );
  return dir;
}

/** A writable stand-in for a terminal stream that records what it was given. */
export function tty({ isTTY = true } = {}) {
  const chunks = [];
  return { isTTY, columns: 80, chunks, write: (chunk) => chunks.push(String(chunk)) };
}

export const breakSources = (dir) =>
  writeFileSync(path.join(dir, "src", "terminal", "broken.ts"), "export const x: number = 'no';\n");

export const posix = process.platform !== "win32";
export const lockPath = (dir) => path.join(dir, "dist", ".terminal-build.lock");
export const cli = (dir, args = []) => [
  path.join(dir, "scripts", "ensure-terminal-built.mjs"),
  ...args,
];
export const waitFor = async (predicate, ms = 15000) => {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

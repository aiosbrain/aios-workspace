#!/usr/bin/env node
// Guard against native-module ABI drift — the better-sqlite3 "NODE_MODULE_VERSION
// 127 vs 147" class of failure that silently breaks the operator-loop DB tests.
//
// Why this exists: every git worktree symlinks `node_modules` from the primary
// checkout (see scripts/link-worktree-env.sh), so they all execute the ONE
// primary-built `better_sqlite3.node`. That prebuild is compiled for a specific
// Node ABI. If the shell running the tests resolves a *different* Node major
// than the one the addon was built for (e.g. Homebrew's Node 26 / ABI 147 vs an
// nvm Node 22 / ABI 127 build), the addon can't load and a single stale build
// poisons every worktree at once. This repo is pinned to Node 22 (.nvmrc /
// .node-version); better-sqlite3@11.x only ships prebuilds up to Node 22/23.
//
// This script probes whether better-sqlite3 actually loads under the active
// Node. On a mismatch it either auto-rebuilds (when the active Node is within
// the installed better-sqlite3's supported range) or prints an actionable
// message telling you to switch to the pinned Node — never a raw ABI number.
//
// Exit codes: 0 = addon loads (healed or already fine); 1 = unresolved mismatch
// (caller decides whether that's fatal — hydration treats it as a warning).

import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const activeAbi = process.versions.modules; // e.g. "127" (Node 22), "147" (Node 26)
const activeMajor = process.versions.node.split('.')[0];

function readPinnedMajor() {
  for (const f of ['.nvmrc', '.node-version']) {
    const p = join(repoRoot, f);
    if (existsSync(p)) {
      const v = readFileSync(p, 'utf8').trim().replace(/^v/, '').split('.')[0];
      if (v) return v;
    }
  }
  return null;
}

function betterSqlite3EnginesRange() {
  try {
    const pkg = require('better-sqlite3/package.json');
    return pkg.engines?.node ?? null;
  } catch {
    return null;
  }
}

// Does the installed better-sqlite3 claim to support the active Node major?
// engines.node looks like "20.x || 22.x || 23.x". A missing range = unknown →
// assume unsupported so we prefer the safe "switch Node" guidance over a rebuild
// that would only fail at compile time.
function supportsActiveMajor(range) {
  if (!range) return false;
  return new RegExp(`(^|\\|)\\s*${activeMajor}(\\.|\\s|$|x)`).test(range);
}

function tryLoad() {
  try {
    // `require()` alone lazy-loads the JS wrapper and does NOT bind the native
    // addon — the ABI mismatch only surfaces when the addon is actually used.
    // Opening an in-memory DB forces the bind, so this is what actually probes.
    const Database = require('better-sqlite3');
    new Database(':memory:').close();
    return { ok: true };
  } catch (err) {
    return { ok: false, err };
  }
}

const pinnedMajor = readPinnedMajor();

let res = tryLoad();
if (res.ok) {
  process.exit(0); // healthy — stay quiet so hydration output isn't noisy
}

// Only self-heal / advise for the ABI-mismatch class; re-throw anything else
// (a genuinely broken install, missing dep) so it isn't masked.
const isAbiMismatch = /NODE_MODULE_VERSION|different Node\.js version|was compiled against/i.test(
  String(res.err?.message ?? res.err),
);
if (!isAbiMismatch) {
  console.error('[native-abi] better-sqlite3 failed to load for a non-ABI reason:');
  console.error(String(res.err?.message ?? res.err));
  process.exit(1);
}

const range = betterSqlite3EnginesRange();
console.error(
  `[native-abi] better-sqlite3 was built for a different Node ABI than the active runtime ` +
    `(active: Node ${activeMajor} / ABI ${activeAbi}).`,
);

if (pinnedMajor && activeMajor !== pinnedMajor) {
  // Wrong Node entirely — the pin is the source of truth. Don't rebuild for an
  // off-pin Node (esp. one the dep has no prebuild for); tell them to switch.
  console.error(
    `[native-abi] This repo is pinned to Node ${pinnedMajor} (.nvmrc). You are on Node ${activeMajor}.` +
      (range && !supportsActiveMajor(range)
        ? ` better-sqlite3 (engines: ${range}) has no prebuild for Node ${activeMajor}.`
        : ''),
  );
  console.error(`[native-abi] Fix: switch to the pinned Node, then reinstall/rebuild:`);
  console.error(`    nvm use            # or: fnm use / mise use  (reads .nvmrc)`);
  console.error(`    npm rebuild better-sqlite3`);
  process.exit(1);
}

// Active Node matches the pin (or no pin) but the binary is stale for it — a
// rebuild against this Node is the right move. node_modules is symlinked from
// the primary, so this rebuilds the shared copy and fixes every worktree.
console.error(`[native-abi] Rebuilding better-sqlite3 for Node ${activeMajor}…`);
try {
  execSync('npm rebuild better-sqlite3', { cwd: repoRoot, stdio: 'inherit' });
} catch {
  console.error('[native-abi] npm rebuild failed — run it manually in the primary checkout.');
  process.exit(1);
}

res = tryLoad();
if (res.ok) {
  console.error('[native-abi] Rebuild succeeded — better-sqlite3 now loads.');
  process.exit(0);
}
console.error('[native-abi] Still failing after rebuild:');
console.error(String(res.err?.message ?? res.err));
process.exit(1);

#!/usr/bin/env node
/**
 * agent-relay.mjs — DEPRECATED standalone entry point.
 *
 * The relay loop now lives in scripts/relay.mjs and is wired into the aios CLI:
 *
 *     npm run aios -- relay "task" [branch] [options]
 *
 * This shim forwards to that single implementation so existing invocations keep
 * working, but it is deprecated and will be removed in a future release. There is
 * exactly one relay implementation (cmdRelay) — this file no longer duplicates it.
 *
 * Migrate:
 *   node scripts/agent-relay.mjs "task" [branch] [opts]
 *     →  npm run aios -- relay "task" [branch] [opts]
 *
 * Note: auto-merge is now opt-in. Pass --merge to merge the branch on approval;
 * without it, relay prints the diff/merge command for you to run manually.
 */

import { cmdRelay } from './relay.mjs';

console.error(
  '\x1b[1;33mwarning:\x1b[0m scripts/agent-relay.mjs is deprecated. ' +
  'Use: npm run aios -- relay "task" [branch] [options]\n' +
  '         (auto-merge is now opt-in — pass --merge to merge on approval)\n'
);

// Forward to the canonical implementation, running git ops in the current repo.
cmdRelay(process.cwd(), process.argv.slice(2)).catch((err) => {
  console.error('\nFatal:', err.message);
  process.exit(1);
});

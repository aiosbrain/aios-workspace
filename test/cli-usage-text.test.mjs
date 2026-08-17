// test/cli-usage-text.test.mjs — the `aios help` text is derived from the registry, so these
// are the assertions that keep the derived text and the descriptors honest about each other.
// Extracted from test/cli-registry.test.mjs (AIO-864 follow-up), which had reached its
// recorded file-size cap: adding `aios validate` to the registry parity table would have
// grown a capped file, and scripts/size-caps.json only ever ratchets down. The extraction is
// behaviour-preserving — same three tests, same imports, no assertion changed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { COMMANDS, findCommand, renderUsage } from "../scripts/cli/registry.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const USAGE_FIXTURE = path.join(DIR, "fixtures", "aios-usage.txt");

test("registry: renderUsage matches the checked-in snapshot", () => {
  assert.ok(existsSync(USAGE_FIXTURE), "test/fixtures/aios-usage.txt is missing");
  assert.equal(`${renderUsage()}\n`, readFileSync(USAGE_FIXTURE, "utf8"));
});

test("registry: every help line beginning `aios <cmd>` names a registered command", () => {
  const named = new Set();
  for (const d of COMMANDS) {
    for (const line of d.usage) {
      const m = /^ {2}aios ([a-z0-9-]+)/.exec(line);
      if (m) named.add(m[1]);
    }
  }
  for (const n of named) {
    assert.ok(findCommand(n), `help documents '${n}' but nothing is registered under that name`);
  }
});

test("registry: usage blocks are owned by their own command", () => {
  for (const d of COMMANDS) {
    const first = d.usage[0];
    if (!first) continue;
    assert.ok(
      first.startsWith(`  aios ${d.name}`),
      `${d.name}'s usage block starts with someone else's line: ${first}`
    );
  }
});

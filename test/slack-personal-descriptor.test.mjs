#!/usr/bin/env node
// test/slack-personal-descriptor.test.mjs — the slack-personal (OAuth) connector descriptor.
//
// Spec: `aios connect slack-personal` is a one-click OAuth flow over the "skill" transport whose
// token lives in the brain. This asserts the descriptor loads/lists with the right shape, that its
// skill payload exists on disk (so storeConnector can install it), and that the bot-token `slack`
// connector is untouched (no scope creep). Zero-dep. Run: node test/slack-personal-descriptor.test.mjs

import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readDescriptors } from "../scripts/gen-catalog.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SCAFFOLD = path.join(DIR, "..", "scaffold");

let failed = 0;
const RED = "\x1b[0;31m",
  GREEN = "\x1b[0;32m",
  NC = "\x1b[0m";
function check(label, cond) {
  if (cond) console.log(`  ${GREEN}✓${NC} ${label}`);
  else {
    console.log(`  ${RED}✗${NC} ${label}`);
    failed++;
  }
}

// readDescriptors always reads the bundled scaffold; pass an empty tmp dir as the "repo".
const descs = readDescriptors(tmpdir());
const sp = descs["slack-personal"];
const slack = descs["slack"];

check("slack-personal descriptor loads", !!sp);
check("auth_mode is oauth", sp?.auth_mode === "oauth");
check("transport is skill", sp?.transport === "skill");
check("skill_name is slack-personal", sp?.skill?.skill_name === "slack-personal");
check(
  "oauth start_url/status_url templated on ${BRAIN_URL}",
  sp?.oauth?.start_url?.includes("${BRAIN_URL}") && sp?.oauth?.status_url?.includes("${BRAIN_URL}")
);
check("oauth auth_header is AIOS_API_KEY", sp?.oauth?.auth_header === "AIOS_API_KEY");
check("token fallback POSTs to the brain", sp?.fallback?.store_url?.includes("/me/slack-token"));
check(
  "skill payload exists on disk (installable)",
  existsSync(path.join(SCAFFOLD, ".claude", "descriptors", "skills", "slack-personal", "SKILL.md"))
);

// The bot-token slack connector must be untouched (separate connector, no scope creep).
check("bot slack connector still present", !!slack);
check(
  "bot slack stays token + mcp",
  slack?.transport === "mcp" && (slack?.auth_mode || "token") === "token"
);

console.log("================================================");
if (failed === 0) {
  console.log(`${GREEN}slack-personal-descriptor tests PASSED${NC}`);
  process.exit(0);
}
console.log(`${RED}slack-personal-descriptor tests FAILED — ${failed} assertion(s)${NC}`);
process.exit(1);

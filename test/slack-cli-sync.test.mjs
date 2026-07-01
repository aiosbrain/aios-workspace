import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const slackPy = join(root, "scaffold/.claude/descriptors/skills/slack-personal/slack.py");
const pinFile = join(root, "scaffold/.claude/descriptors/skills/slack-personal/slack.py.sha256");

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const actual = sha256(slackPy);
const expected = readFileSync(pinFile, "utf8").trim();

if (actual !== expected) {
  console.error("slack-cli-sync: slack.py SHA256 mismatch");
  console.error(`  pin:    ${expected}`);
  console.error(`  actual: ${actual}`);
  console.error(
    "  canonical source: hermes-aluna/bin/slack.py — update both copies + pin together"
  );
  process.exit(1);
}

console.log(`slack-cli-sync: ok (${actual.slice(0, 12)}…)`);

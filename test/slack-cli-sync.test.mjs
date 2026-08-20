import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
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
    "  canonical source: THIS file (scaffold/.claude/descriptors/skills/slack-personal/slack.py)."
  );
  console.error(
    "  hermes-aluna/bin/slack.py and any workspace .claude/skills/slack-personal/ copy are"
  );
  console.error(
    "  DEPLOYMENTS of it, not sources. Change it here, re-pin, then propagate outward —"
  );
  console.error(
    "  the two copies drifted in OPPOSITE directions once already (one gained `file`, the"
  );
  console.error("  other `resolve --member`) precisely because the direction was ambiguous.");
  process.exit(1);
}

console.log(`slack-cli-sync: ok (${actual.slice(0, 12)}…)`);

const help = spawnSync("python3", [slackPy, "dm", "--help"], { encoding: "utf8" });
if (help.status !== 0 || !help.stdout.includes("--message-stdin")) {
  console.error("slack-cli-sync: multiline message input is not exposed by the CLI");
  process.exit(1);
}

console.log("slack-cli-sync: multiline input ok");

// The verb surface is the thing that silently diverged between copies. Assert it here, where a
// missing verb is a one-line failure, rather than discovering it from an agent that fell back to
// some other tool because `slack file` did not exist in the copy it happened to reach.
const top = spawnSync("python3", [slackPy, "--help"], { encoding: "utf8" });
for (const verb of ["file", "resolve", "dm", "send", "read", "react", "channels", "whoami"]) {
  if (!top.stdout.includes(verb)) {
    console.error(`slack-cli-sync: the CLI no longer exposes '${verb}'`);
    process.exit(1);
  }
}

console.log("slack-cli-sync: verb surface ok");

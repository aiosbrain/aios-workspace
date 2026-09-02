// AIO-1072 — the Python Slack client is retired; this file used to pin slack.py's SHA256
// against its deployments. It now asserts the retirement HOLDS: no Python client (or its
// sha pin, or the descriptor activity clients) may reappear in the scaffold, and the
// surviving slack-personal skill doc routes through the built-in `aios slack` adapter.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const skillDir = join(root, "scaffold/.claude/descriptors/skills/slack-personal");

let failed = 0;
function check(label, cond) {
  if (cond) console.log(`slack-cli-sync: ok — ${label}`);
  else {
    console.error(`slack-cli-sync: FAIL — ${label}`);
    failed++;
  }
}

for (const gone of ["slack.py", "slack.py.sha256", "slack-activity-pull.mjs"]) {
  check(
    `${gone} stays deleted (built-in adapter owns the surface)`,
    !existsSync(join(skillDir, gone))
  );
}

check(
  "slack-personal ships routing documentation only (SKILL.md, no executables)",
  readdirSync(skillDir).every((name) => name.endsWith(".md"))
);

const skillMd = readFileSync(join(skillDir, "SKILL.md"), "utf8");
check("SKILL.md routes through `aios slack`", skillMd.includes("aios slack "));
check("SKILL.md names the activity verb", skillMd.includes("aios slack activity pull"));
check("SKILL.md no longer instructs running python", !/python3?\s/.test(skillMd));

if (failed > 0) process.exit(1);
console.log("slack-cli-sync: retirement holds");

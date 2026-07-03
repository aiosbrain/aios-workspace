#!/usr/bin/env node
// test/wait-for-bots-bots.test.mjs — the additive --bots selector.
// selectBots validates against BOT_CONFIG (unknown → usage error) and filters to the requested
// bots. A fast spawn with a fake gh where ONLY Bugbot is ready + --bots cursor[bot] exits 0.
// A Bugbot check-run with a `skipped` conclusion counts as satisfied. Zero-dep, no live gh.
// Run: node test/wait-for-bots-bots.test.mjs

import { selectBots } from "../scripts/wait-for-bots.mjs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(DIR, "..", "scripts", "wait-for-bots.mjs");

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

const CONFIG = { "cursor[bot]": {}, "coderabbitai[bot]": {} };

console.log("selectBots");
{
  check(
    "no arg → all bots",
    JSON.stringify(selectBots(CONFIG, null)) === JSON.stringify(Object.keys(CONFIG))
  );
  check("empty string → all bots", selectBots(CONFIG, "").length === 2);
  check(
    "single bot → just it",
    JSON.stringify(selectBots(CONFIG, "cursor[bot]")) === JSON.stringify(["cursor[bot]"])
  );
  check(
    "comma list → both, in config order",
    JSON.stringify(selectBots(CONFIG, "coderabbitai[bot],cursor[bot]")) ===
      JSON.stringify(["cursor[bot]", "coderabbitai[bot]"])
  );
  check(
    "repeated flag (array) → filtered",
    JSON.stringify(selectBots(CONFIG, ["cursor[bot]"])) === JSON.stringify(["cursor[bot]"])
  );
  let threw = false;
  try {
    selectBots(CONFIG, "nonsense[bot]");
  } catch (e) {
    threw = /unknown bot/.test(e.message);
  }
  check("unknown bot → usage error", threw);
}

// Fake gh: only Bugbot (cursor[bot]) is ready — as a `skipped` check run. CodeRabbit absent.
function makeGh(conclusion) {
  const dir = mkdtempSync(path.join(tmpdir(), "wfb-bots-gh-"));
  const bin = path.join(dir, "gh");
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env node",
      "const a = process.argv.slice(2).join(' ');",
      "if (a.includes('check-runs')) {",
      `  process.stdout.write(JSON.stringify([{name:'Bugbot',status:'completed',conclusion:'${conclusion}',completed_at:'2020-01-01T00:00:00Z'}]));`,
      "} else if (a.includes('/commits')) {",
      "  process.stdout.write('');",
      "} else if (a.startsWith('pr view') || a.includes('headRefOid')) {",
      "  process.stdout.write('deadbeef');",
      "} else {",
      "  process.stdout.write('[]');",
      "}",
    ].join("\n")
  );
  chmodSync(bin, 0o755);
  return dir;
}

function run(ghDir, extraArgs) {
  try {
    execFileSync(process.execPath, [SCRIPT, "--pr", "1", "--repo", "acme/repo", ...extraArgs], {
      env: { ...process.env, PATH: [ghDir, process.env.PATH].join(path.delimiter) },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30000,
    });
    return 0;
  } catch (e) {
    return e.status ?? -1;
  }
}

console.log("spawn: --bots cursor[bot] gates on Bugbot alone");
{
  const gh = makeGh("skipped");
  check(
    "--bots cursor[bot] with skipped Bugbot → exit 0",
    run(gh, ["--bots", "cursor[bot]"]) === 0
  );
  // Without narrowing, CodeRabbit is still required → the 10-min timeout would apply; instead
  // assert an unknown --bots value fails fast with exit 1 (usage), quickly.
  check("unknown --bots → exit 1", run(gh, ["--bots", "nope[bot]", "--timeout", "1"]) === 1);
  rmSync(gh, { recursive: true, force: true });
}

console.log("Bugbot check-run conclusion 'skipped' is satisfied");
{
  const gh = makeGh("skipped");
  check("skipped conclusion → ready → exit 0", run(gh, ["--bots", "cursor[bot]"]) === 0);
  rmSync(gh, { recursive: true, force: true });
}

console.log(failed ? `${RED}${failed} check(s) failed${NC}` : `${GREEN}all checks passed${NC}`);
process.exit(failed ? 1 : 0);

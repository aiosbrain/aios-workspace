#!/usr/bin/env node
// test/wait-for-bots-exit.test.mjs — the require-all-by-default exit contract.
//
// The timeout path can't be spawned quickly (the poll loop has a 1-minute floor), so
// the exit-code decision is unit-tested via the pure decideTimeoutExit helper. A fast
// spawn with a fake `gh` on PATH (bots already ready) covers the all-ready exit-0 path
// and that --any / --require-all are accepted. Zero-dep, no live gh/git.

import { decideTimeoutExit } from "../scripts/wait-for-bots.mjs";
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

console.log("decideTimeoutExit — require-all by default");
{
  const d1 = decideTimeoutExit({ proceedOnTimeout: false, missing: ["cursor[bot]"] });
  check("missing bot, default → exit 2, do not proceed", d1.code === 2 && d1.proceed === false);

  const d2 = decideTimeoutExit({ proceedOnTimeout: true, missing: ["cursor[bot]"] });
  check("missing bot, --any → exit 0, proceed", d2.code === 0 && d2.proceed === true);

  const d3 = decideTimeoutExit({ proceedOnTimeout: false, missing: [] });
  check("no missing bot → exit 0, proceed", d3.code === 0 && d3.proceed === true);
}

// A fake `gh` reporting both bots as completed check runs → the script exits 0 on the
// first poll (no waiting). Both --require-all (no-op) and --any must still exit 0 here.
const ghDir = mkdtempSync(path.join(tmpdir(), "wfb-gh-"));
const ghBin = path.join(ghDir, "gh");
writeFileSync(
  ghBin,
  [
    "#!/usr/bin/env node",
    "const a = process.argv.slice(2).join(' ');",
    "if (a.includes('check-runs')) {",
    "  process.stdout.write(JSON.stringify([",
    "    {name:'Bugbot',status:'completed',conclusion:'success',completed_at:'2020-01-01T00:00:00Z'},",
    "    {name:'CodeRabbit',status:'completed',conclusion:'success',completed_at:'2020-01-01T00:00:00Z'}",
    "  ]));",
    "} else if (a.includes('/commits')) {",
    "  process.stdout.write('');", // no latest-push time → no timestamp filtering
    "} else if (a.startsWith('pr view') || a.includes('headRefOid')) {",
    "  process.stdout.write('deadbeef');",
    "} else {",
    "  process.stdout.write('[]');",
    "}",
  ].join("\n")
);
chmodSync(ghBin, 0o755);

function runReady(extraArgs) {
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

console.log("spawn with ready bots (fake gh)");
{
  check("default → exit 0 (all ready)", runReady([]) === 0);
  check("--any accepted → exit 0", runReady(["--any"]) === 0);
  check("--require-all accepted (no-op) → exit 0", runReady(["--require-all"]) === 0);
}

rmSync(ghDir, { recursive: true, force: true });

console.log(failed ? `${RED}${failed} check(s) failed${NC}` : `${GREEN}all checks passed${NC}`);
process.exit(failed ? 1 : 0);

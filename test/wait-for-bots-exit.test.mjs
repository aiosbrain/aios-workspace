#!/usr/bin/env node
// CodeRabbit wait command exit contract. Fake gh only; no network.

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

console.log("decideTimeoutExit");
{
  const d1 = decideTimeoutExit({ proceedOnTimeout: false, missing: ["coderabbitai[bot]"] });
  check("missing CodeRabbit, default → exit 2", d1.code === 2 && d1.proceed === false);
  const d2 = decideTimeoutExit({ proceedOnTimeout: true, missing: ["coderabbitai[bot]"] });
  check("missing CodeRabbit, --any → exit 0", d2.code === 0 && d2.proceed === true);
  const d3 = decideTimeoutExit({ proceedOnTimeout: false, missing: [] });
  check("no missing evidence → exit 0", d3.code === 0 && d3.proceed === true);
}

function makeGh({ ready }) {
  const dir = mkdtempSync(path.join(tmpdir(), "wfb-gh-"));
  const bin = path.join(dir, "gh");
  const body =
    "CodeRabbit reviewed the exact current head and found the implementation consistent. " +
    "It checked the changed control flow, failure handling, and the relevant regression tests.";
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env node",
      "const a = process.argv.slice(2).join(' ');",
      "if (a.includes('/pulls/1/commits')) {",
      "  process.stdout.write('2026-07-01T00:00:00Z');",
      "} else if (a.includes('/issues/1/comments')) {",
      ready
        ? `  process.stdout.write(${JSON.stringify(JSON.stringify([{ user: "coderabbitai[bot]", body, created_at: "2026-07-01T00:00:01Z" }]))});`
        : "  process.stdout.write('[]');",
      "} else {",
      "  process.stdout.write('[]');",
      "}",
    ].join("\n")
  );
  chmodSync(bin, 0o755);
  return dir;
}

function run(ghDir, extraArgs = []) {
  try {
    execFileSync(process.execPath, [SCRIPT, "--pr", "1", "--repo", "acme/repo", ...extraArgs], {
      env: { ...process.env, PATH: [ghDir, process.env.PATH].join(path.delimiter) },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
    return 0;
  } catch (error) {
    return error.status ?? -1;
  }
}

console.log("spawn with current-head CodeRabbit evidence");
{
  const ghDir = makeGh({ ready: true });
  check("default → exit 0", run(ghDir) === 0);
  check("explicit CodeRabbit → exit 0", run(ghDir, ["--bots", "coderabbitai[bot]"]) === 0);
  check("unknown Cursor selector → exit 1", run(ghDir, ["--bots", "cursor[bot]"]) === 1);
  rmSync(ghDir, { recursive: true, force: true });
}

console.log("timeout behavior");
{
  const ghDir = makeGh({ ready: false });
  check("zero-minute timeout without evidence → exit 2", run(ghDir, ["--timeout", "0"]) === 2);
  check("--any explicitly permits timeout → exit 0", run(ghDir, ["--timeout", "0", "--any"]) === 0);
  rmSync(ghDir, { recursive: true, force: true });
}

console.log(failed ? `${RED}${failed} check(s) failed${NC}` : `${GREEN}all checks passed${NC}`);
process.exit(failed ? 1 : 0);

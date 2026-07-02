#!/usr/bin/env node
// test/build-fence.test.mjs — the builder fence (G2) + model/effort wiring (Scope 6),
// exercised through the real build loop with fake agents on PATH. A capture `claude`
// records each builder invocation's prompt + --model + --effort + GIT_CEILING_DIRECTORIES
// env to a file, then makes a real commit so the loop proceeds. A Medium-only `cursor`
// review keeps rejecting, so we capture BOTH the initial build round and a fix round.
// Zero-dep, no network. Run: node test/build-fence.test.mjs

import {
  mkdtempSync,
  mkdirSync,
  cpSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runBuild, slugify, BUILDER_FENCE, EXIT } from "../scripts/build.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(DIR, "..");

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

// ── BUILDER_FENCE content ───────────────────────────────────────────────────
console.log("BUILDER_FENCE content");
{
  check("forbids git push", /Do NOT `git push`/.test(BUILDER_FENCE));
  check(
    "forbids PR creation",
    /Do NOT create, edit, or\s+comment on any GitHub PR/.test(BUILDER_FENCE)
  );
  check("worktree-only", /THIS worktree only/.test(BUILDER_FENCE));
  check("no primary-checkout touch", /primary checkout/.test(BUILDER_FENCE));
}

// ── fake agents on PATH ─────────────────────────────────────────────────────
const bin = mkdtempSync(path.join(tmpdir(), "fence-bin-"));
const capture = path.join(bin, "capture.log");

// capture `claude`: records one JSON line per build invocation, then commits.
writeFileSync(
  path.join(bin, "claude"),
  [
    "#!/usr/bin/env node",
    "import { appendFileSync } from 'node:fs';",
    "import { execFileSync } from 'node:child_process';",
    "const a = process.argv.slice(2);",
    "if (a.includes('--version')) { console.log('fake-claude 0.0.0'); process.exit(0); }",
    "const val = (f) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : null; };",
    "const prompt = val('-p') || '';",
    "const rec = {",
    "  prompt,",
    "  model: val('--model'),",
    "  effort: val('--effort'),",
    "  ceiling: process.env.GIT_CEILING_DIRECTORIES || null,",
    "};",
    "appendFileSync(process.env.CAPTURE, JSON.stringify(rec) + '\\n');",
    "// make a real, unique commit so the loop sees new work each round",
    "const marker = 'export const built = true; // ' + Date.now() + '-' + process.pid + '\\n';",
    "appendFileSync('feature.js', marker);",
    "execFileSync('git', ['add', '-A'], { cwd: process.cwd(), stdio: 'pipe' });",
    "execFileSync('git', ['commit', '-m', 'build', '--no-verify'], { cwd: process.cwd(), stdio: 'pipe' });",
    "console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } }));",
    "process.exit(0);",
  ].join("\n")
);

// Medium-only `cursor`: never approves, never lists Critical/High → keeps the loop in
// the "fix" (not "fix_escalated") lane on the first fix attempt.
writeFileSync(
  path.join(bin, "cursor"),
  [
    "#!/usr/bin/env node",
    "const a = process.argv.slice(2);",
    "if (a[0] === '--version') { console.log('fake-cursor 0.0.0'); process.exit(0); }",
    "const text = '## Findings\\n\\n- Medium: please tidy this up.\\n\\nNot ready to merge.';",
    "console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }));",
    "process.exit(0);",
  ].join("\n")
);
chmodSync(path.join(bin, "claude"), 0o755);
chmodSync(path.join(bin, "cursor"), 0o755);
process.env.PATH = [bin, process.env.PATH].join(path.delimiter);
process.env.CAPTURE = capture;

function freshRepo() {
  const repo = mkdtempSync(path.join(tmpdir(), "fence-repo-"));
  const g = (args) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  g(["init", "-b", "main"]);
  g(["config", "user.email", "t@example.com"]);
  g(["config", "user.name", "T"]);
  mkdirSync(path.join(repo, "scripts"), { recursive: true });
  cpSync(path.join(REPO, "scripts", "leak-gate.sh"), path.join(repo, "scripts", "leak-gate.sh"));
  cpSync(path.join(REPO, "validation"), path.join(repo, "validation"), { recursive: true });
  writeFileSync(path.join(repo, "README.md"), "# base\n");
  g(["add", "-A"]);
  g(["commit", "-m", "base"]);
  return repo;
}

const opts = {
  rounds: 2,
  buildTimeout: 60000,
  cursorTimeout: 60000,
  cursorTimeoutSet: false,
  model: null,
  skill: "/ai-code-review",
  base: "main",
  verify: null,
  worktreePath: null,
  logFile: null,
  merge: false,
  pr: false,
  issue: null,
  noGate: false,
  bugbot: false,
  noBugbot: true,
  keepWorktree: false,
  dryRun: false,
};

// Silence the loop's streaming output.
const origOut = process.stdout.write.bind(process.stdout);
const origLog = console.log;
const origErr = console.error;

console.log("fence + model/effort on the initial build AND a fix round");
{
  const repo = freshRepo();
  const wt = path.resolve(repo, "..", `${path.basename(repo)}-${slugify("feat/fence")}`);
  writeFileSync(capture, "");

  process.stdout.write = () => true;
  console.log = () => {};
  console.error = () => {};
  let code;
  try {
    code = await runBuild({ repo, plan: "Add a feature module.", branch: "feat/fence", opts });
  } finally {
    process.stdout.write = origOut;
    console.log = origLog;
    console.error = origErr;
  }

  const recs = readFileSync(capture, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

  check("loop ran two builder rounds", recs.length === 2);
  check("exit NONCONVERGENCE (reviewer never approves)", code === EXIT.NONCONVERGENCE);

  const [r1, r2] = recs;
  check("round 1 prompt is fenced", r1.prompt.startsWith(BUILDER_FENCE));
  check("round 2 prompt is fenced", r2.prompt.startsWith(BUILDER_FENCE));
  check("round 1 GIT_CEILING_DIRECTORIES = worktree parent", r1.ceiling === path.dirname(wt));
  check("round 2 GIT_CEILING_DIRECTORIES = worktree parent", r2.ceiling === path.dirname(wt));

  // Round 1 = initial "build" step (effort high); round 2 = "fix" (Medium-only → medium).
  check("round 1 uses the build model", r1.model === "claude-opus-4-8");
  check("round 1 effort = high (build step)", r1.effort === "high");
  check("round 2 effort = medium (fix step)", r2.effort === "medium");

  rmSync(repo, { recursive: true, force: true });
  rmSync(wt, { recursive: true, force: true });
}

rmSync(bin, { recursive: true, force: true });

console.log(failed ? `${RED}${failed} check(s) failed${NC}` : `${GREEN}all checks passed${NC}`);
process.exit(failed ? 1 : 0);

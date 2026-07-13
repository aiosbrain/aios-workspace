#!/usr/bin/env node
// Codex must receive the selected model and worktree, while ship receives only its final message.
import { callAgentModel } from "../scripts/model-call.mjs";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

let failed = 0;
function check(label, condition) {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    console.log(`  ✗ ${label}`);
    failed++;
  }
}

const dir = mkdtempSync(path.join(tmpdir(), "model-call-codex-"));
const shimDir = path.join(dir, "bin");
const worktree = path.join(dir, "worktree");
const argsFile = path.join(dir, "args.json");
await mkdir(shimDir, { recursive: true });
await mkdir(worktree);
const shim = path.join(shimDir, "codex");
writeFileSync(
  shim,
  `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nconst args = process.argv.slice(2);\nwriteFileSync(${JSON.stringify(argsFile)}, JSON.stringify(args));\nconst i = args.indexOf('--output-last-message');\nwriteFileSync(args[i + 1], 'Codex final message\\n');\n`
);
chmodSync(shim, 0o755);
const oldPath = process.env.PATH;
process.env.PATH = [shimDir, oldPath].join(path.delimiter);

console.log("codex provider dispatch");
const result = await callAgentModel({
  model: "codex:gpt-5.6-sol",
  prompt: "implement the issue",
  timeoutMs: 30_000,
  opts: { cwd: worktree },
});
const args = JSON.parse(readFileSync(argsFile, "utf8"));
check("returns only Codex final message", result === "Codex final message");
check("uses codex exec", args[0] === "exec");
check("forwards the requested model", args[args.indexOf("--model") + 1] === "gpt-5.6-sol");
check("runs in the supplied worktree", args[args.indexOf("--cd") + 1] === worktree);
check("passes the prompt", args.at(-1) === "implement the issue");

process.env.PATH = oldPath;
rmSync(dir, { recursive: true, force: true });
console.log(failed ? `${failed} check(s) failed` : "all checks passed");
process.exitCode = failed ? 1 : 0;

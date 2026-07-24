#!/usr/bin/env node
// workstream-update.mjs — propose 3–5 non-overlapping agent workstreams from the AIO board.
// Run from workspace root:
//   dotenvx run --quiet -f .env -- node .claude/skills/workstream-update/workstream-update.mjs [--json]
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LINEAR = path.join(HERE, "..", "aios-linear", "linear.mjs");

const ACTIVE_STATES = /^(in progress|triage|backlog|todo|started)/i;
const DONE_STATES = /^(done|canceled|cancelled)/i;

function runLinear(args) {
  const r = spawnSync(process.execPath, [LINEAR, ...args], {
    encoding: "utf8",
    env: process.env,
  });
  if (r.status !== 0) {
    console.error(r.stderr || r.stdout);
    process.exit(r.status || 1);
  }
  return r.stdout;
}

function parseList(stdout) {
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [ident, state, ...rest] = line.split("\t");
      return { ident, state: state?.replace(/^\[|\]$/g, "") ?? "", title: rest.join("\t") };
    });
}

function scoreIssue(row) {
  if (DONE_STATES.test(row.state)) return -1;
  if (/in progress/i.test(row.state)) return 100;
  if (/triage/i.test(row.state)) return 80;
  if (/backlog|todo/i.test(row.state)) return 50;
  return 10;
}

function buildWorkstreams(candidates, max = 5) {
  const sorted = [...candidates].sort((a, b) => scoreIssue(b) - scoreIssue(a));
  const picked = [];
  for (const row of sorted) {
    if (picked.length >= max) break;
    if (scoreIssue(row) < 0) continue;
    picked.push(row);
  }
  return picked.slice(0, Math.min(max, Math.max(3, picked.length)));
}

function renderMarkdown(workstreams, { generatedAt = new Date().toISOString() } = {}) {
  const lines = [
    "# Workstream update",
    "",
    `Generated: ${generatedAt}`,
    "",
    "## Context",
    "",
    "- Finish **In Progress** issues before starting new epics.",
    "- Each workstream below is **unsupervised** (no mid-batch AskUser). Escalate via Linear comment with copy-pasteable steps.",
    "- Closeout: PR merge → tick acceptance subsections → `.aios/loop/<AIO-n>/` transcript → `aios time capture`.",
    "",
    "## Proposed workstreams",
    "",
  ];
  workstreams.forEach((row, i) => {
    lines.push(
      `### Workstream ${i + 1}: ${row.ident} — ${row.title}`,
      "",
      `**State:** ${row.state}`,
      "",
      "**Agent prompt (paste into harness):**",
      "",
      "```",
      `You are an unsupervised batch agent. Complete ${row.ident} end-to-end.`,
      "",
      `1. linear.mjs get ${row.ident} --full  (read contract + comments)`,
      `2. aios spec eval on the issue body must be SPEC_READY before build; fix if needed`,
      `3. Implement, open PR titled "(${row.ident}) …", ensure CI green`,
      `4. Merge when review bar met; verify board → Done`,
      `5. Tick Automated/Manual/Visual checks in the issue; comment closeout summary`,
      "```",
      ""
    );
  });
  if (!workstreams.length) {
    lines.push("_No active candidates on the AIO board._", "");
  }
  return lines.join("\n");
}

const asJson = process.argv.includes("--json");
const rows = parseList(runLinear(["list", "AIO"])).filter((r) => scoreIssue(r) >= 0);
const workstreams = buildWorkstreams(rows);

if (asJson) {
  console.log(JSON.stringify({ workstreams, generatedAt: new Date().toISOString() }, null, 2));
} else {
  console.log(renderMarkdown(workstreams));
}

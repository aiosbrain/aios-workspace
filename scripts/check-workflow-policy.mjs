#!/usr/bin/env node
/**
 * Workflow-policy gate — static policy over GitHub Actions workflows
 * (leak-gate-remediation-plan.md §5.1 item 3, phase 4).
 *
 * WHAT THIS IS NOT, FIRST: this checker does **not** create, write, or influence the required
 * `AIOS Security Gate` status. That status may only ever come from the `aios-security-gate`
 * GitHub App (plan §1 invariant 3). This is an ordinary unprivileged CI job: it runs with
 * `permissions: contents: read`, holds no secret, makes no network call, and reads workflow YAML
 * as DATA — it never executes a workflow, a step, an action, or a `run:` body.
 *
 * It fails when a workflow REACHABLE FROM A PR-LIKE EVENT:
 *
 *   secrets-in-pr-reachable      references `secrets.*`
 *   elevated-permissions         requests `checks: write` or `statuses: write`
 *   security-gate-context        writes/names the `AIOS Security Gate` status context
 *   mutable-action-ref           has a `uses:` not pinned to a full 40-hex commit SHA
 *   pr-target-checkout           `pull_request_target` + checkout/fetch of PR-controlled content
 *   pr-target-artifact-download  `pull_request_target` + artifact download
 *   pr-target-package-install    `pull_request_target` + package manager / build tool invocation
 *   pr-target-dynamic-run        `pull_request_target` + `${{ }}` interpolation of attacker-
 *                                controlled expressions directly into a `run:`/`script:` body
 *   unparseable-workflow         the file could not be read as data at all (fail-closed)
 *   allowlist-entry-invalid      a waiver without a rule, an owner, or a real justification
 *
 * The last four are the four facets of the plan's single `pull_request_target` rule, split so a
 * waiver can name the one it suspends. `secrets.*` is matched only inside a `${{ }}` expression,
 * where it is the only place the word means anything to Actions — `check-secrets.sh` in a `run:`
 * body is a filename, not a credential read.
 *
 * "PR-like" means `pull_request`, `pull_request_target`, `pull_request_review`,
 * `pull_request_review_comment`, `issue_comment`, and `workflow_run` whose upstream workflow is
 * itself PR-like. Reachability also follows local reusable-workflow calls
 * (`uses: ./.github/workflows/x.yml`), because a `workflow_call` file inherits the caller's
 * trigger and its secrets. Every unresolvable edge resolves to REACHABLE, never to safe.
 *
 * Waivers live in `scripts/workflow-policy-allowlist.json`, scoped to one (workflow, job, rule)
 * triple. There is deliberately no way to skip a whole file or waive every rule: a waiver names
 * the single rule it suspends, an accountable owner, and a justification, or it is itself a
 * failure. Stale waivers are reported as notes rather than failures so that fixing a violation in
 * one PR cannot turn `main` red before the waiver is deleted in another.
 *
 * Zero dependencies (runs in a CI job with no `npm ci`, like the other guards in scripts/).
 *
 *   node scripts/check-workflow-policy.mjs [--dir <workflows-dir>] [--allowlist <file>]
 *
 * Exit 0 clean, 1 policy violation, 2 bad invocation / unreadable allowlist.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseWorkflowYaml } from "./workflow-yaml.mjs";
import {
  RULES,
  auditWorkflow,
  computeReachability,
  validateAllowlist,
} from "./workflow-policy-rules.mjs";

export {
  RULES,
  auditWorkflow,
  computeReachability,
  mutableUsesRef,
  triggersOf,
  validateAllowlist,
} from "./workflow-policy-rules.mjs";

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));

function loadWorkflowFiles(dir, root) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort()
    .map((name) => {
      const abs = path.join(dir, name);
      const rel = path.relative(root, abs).split(path.sep).join("/");
      const text = readFileSync(abs, "utf8");
      try {
        return { rel, text, doc: parseWorkflowYaml(text), error: null };
      } catch (e) {
        return { rel, text, doc: null, error: e };
      }
    });
}

function sourceLine(file, line) {
  const raw = line > 0 ? (file.text.split(/\r?\n/)[line - 1] ?? "").trim() : "";
  return raw.length > 140 ? raw.slice(0, 137) + "…" : raw;
}

function parseArgs(argv) {
  const opts = { dir: null, allowlist: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dir" || a === "--allowlist") {
      const value = argv[++i];
      if (value === undefined) return { error: `${a} needs a value` };
      opts[a === "--dir" ? "dir" : "allowlist"] = value;
    } else if (a === "--help" || a === "-h") return { help: true };
    else return { error: `unknown argument: ${a}` };
  }
  return { opts };
}

/** Read + validate the waiver file. A missing file is an empty allowlist; a broken one is fatal. */
function loadAllowlist(allowlistPath, cwd) {
  let raw = { entries: [] };
  if (existsSync(allowlistPath)) {
    try {
      raw = JSON.parse(readFileSync(allowlistPath, "utf8"));
    } catch (e) {
      return { error: `cannot read allowlist ${allowlistPath}: ${e.message}` };
    }
  }
  return validateAllowlist(raw, path.relative(cwd, allowlistPath).split(path.sep).join("/"));
}

/** Audit every PR-reachable workflow. An unreadable file is a finding, never a skip. */
function collectFindings(files, reachable) {
  const findings = [];
  for (const file of files) {
    if (!reachable.has(file.rel)) continue;
    if (file.error)
      findings.push({
        file: file.rel,
        job: "(file)",
        rule: "unparseable-workflow",
        line: file.error.line ?? 0,
        detail: file.error.message,
      });
    else findings.push(...auditWorkflow(file));
  }
  return findings;
}

/** Partition findings into waived (an entry matched) and failing, marking entries as used. */
function applyAllowlist(findings, entries) {
  const waived = [];
  const failures = [];
  for (const finding of findings) {
    const entry = entries.find(
      (e) =>
        e.workflow === finding.file &&
        (e.job === "*" || e.job === finding.job) &&
        e.rule === finding.rule
    );
    if (entry) {
      entry.used = true;
      waived.push({ finding, entry });
    } else failures.push(finding);
  }
  return { waived, failures };
}

function reportFailures(failures, { byRel, reachable, err }) {
  err(`\n${failures.length} workflow-policy violation(s):\n`);
  for (const f of failures) {
    const file = byRel.get(f.file);
    const rule = RULES[f.rule];
    err(`FAIL  ${f.file}${f.line ? `:${f.line}` : ""}  job \`${f.job}\`  [${f.rule}]`);
    if (reachable.has(f.file)) err(`      reachable from: ${reachable.get(f.file)}`);
    err(`      ${f.detail}`);
    if (file && f.line) err(`      source: ${sourceLine(file, f.line)}`);
    err(`      why:  ${rule.why}`);
    err(`      fix:  ${rule.fix}`);
    err("");
  }
  err(
    "This job never writes the `AIOS Security Gate` status and holds no secret. Fix the workflow, " +
      "or add a reviewed (workflow, job, rule) waiver with an owner and a justification to " +
      "scripts/workflow-policy-allowlist.json."
  );
}

export function main(
  argv = process.argv.slice(2),
  { cwd = process.cwd(), log = console.log, err = console.error } = {}
) {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    log(
      "usage: node scripts/check-workflow-policy.mjs [--dir <workflows-dir>] [--allowlist <file>]"
    );
    return 0;
  }
  if (parsed.error) {
    err(`check-workflow-policy: ${parsed.error}`);
    return 2;
  }
  const dir = path.resolve(cwd, parsed.opts.dir ?? ".github/workflows");
  const allowlistPath = path.resolve(
    cwd,
    parsed.opts.allowlist ??
      process.env.CHECK_WORKFLOW_POLICY_ALLOWLIST ??
      path.join(SELF_DIR, "workflow-policy-allowlist.json")
  );

  const loaded = loadAllowlist(allowlistPath, cwd);
  if (loaded.error) {
    err(`check-workflow-policy: ${loaded.error}`);
    return 2;
  }
  const { entries, findings: allowlistFindings } = loaded;

  const files = loadWorkflowFiles(dir, cwd);
  const reachable = computeReachability(files);
  const byRel = new Map(files.map((f) => [f.rel, f]));
  const findings = [...allowlistFindings, ...collectFindings(files, reachable)];

  const { waived, failures } = applyAllowlist(findings, entries);

  log(
    `workflow policy — ${files.length} workflow file(s) in ${path.relative(cwd, dir) || dir}, ` +
      `${reachable.size} reachable from PR-like events`
  );
  for (const [rel, reason] of [...reachable].sort()) log(`  PR-reachable  ${rel}  (via ${reason})`);

  if (waived.length) {
    log(`\n${waived.length} waived finding(s) — scripts/workflow-policy-allowlist.json:`);
    for (const { finding, entry } of waived)
      log(
        `  waived  ${finding.file}  job \`${finding.job}\`  [${finding.rule}]  owner: ${entry.owner}`
      );
  }
  // A stale entry is a NOTE, not a failure: the PR that fixes a violation and the PR that deletes
  // its waiver are often different PRs, and a hard failure here would redden main between them.
  const stale = entries.filter((e) => !e.used);
  if (stale.length) {
    log(
      `\n${stale.length} allowlist entr(y/ies) matched nothing — delete them (note, not a failure):`
    );
    for (const e of stale) log(`  stale   ${e.workflow}  job \`${e.job}\`  [${e.rule}]`);
  }

  if (!failures.length) {
    log("\nworkflow policy: OK — no unwaived violation in any PR-reachable workflow.");
    return 0;
  }
  reportFailures(failures, { byRel, reachable, err });
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}

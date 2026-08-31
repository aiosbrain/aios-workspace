/**
 * workflow-policy-rules.mjs — the rule catalogue, PR-reachability graph, and audit for
 * `scripts/check-workflow-policy.mjs` (leak-gate-remediation-plan.md §5.1 item 3).
 *
 * Split out of the CLI so the policy itself stays readable and directly unit-testable, and so the
 * entry point stays under the file-size cap. Everything here is pure: it takes parsed workflow
 * documents as DATA and returns findings. It never reads the filesystem, makes a network call,
 * spawns a process, or writes a commit status — see the header of check-workflow-policy.mjs for
 * why the last one is the whole point.
 *
 * Zero dependencies.
 */
import path from "node:path";
import { walkScalars } from "./workflow-yaml.mjs";

/** Rule catalogue. `why` states the failure this prevents; `fix` is the remediation prompt. */
export const RULES = {
  "unparseable-workflow": {
    why: "A workflow this gate cannot read as data is a workflow it cannot police. Passing it would let any construct the reader does not model become a blind spot.",
    fix: "Simplify the file to plain block YAML (no anchors, aliases, merge keys, explicit tags, or multiple documents), or extend scripts/workflow-yaml.mjs to model the construct — with a test.",
  },
  "secrets-in-pr-reachable": {
    why: "A job reachable from a pull request must not hold a durable credential: PR-controlled code, dependencies, or workflow YAML can exfiltrate it (leak-gate-remediation-plan.md §1 invariant 1).",
    fix: "Move the credentialed work to a trusted, default-branch-only workflow or to the security service, and leave the PR-reachable job unprivileged.",
  },
  "elevated-permissions": {
    why: "`checks: write` / `statuses: write` in a PR-reachable job is the forgery primitive for the required `AIOS Security Gate` status. Only the App's installation token may write it (§5.2).",
    fix: "Drop the scope. If a status genuinely must be published, publish it from a trusted workflow that PR content cannot reach.",
  },
  "security-gate-context": {
    why: "The `AIOS Security Gate` context belongs to the `aios-security-gate` GitHub App alone. A workflow naming it can only be trying to write, shadow, or satisfy it (§1 invariant 3).",
    fix: "Remove the reference. Actions never produces this context; branch protection binds it to the App's source.",
  },
  "mutable-action-ref": {
    why: "A tag or branch ref is repointable by the action's owner, so a green review is not evidence about the code that will actually run in a job that can see this repository.",
    fix: "Pin to the full 40-hex commit SHA and keep the human-readable version in a trailing comment, e.g. `uses: actions/checkout@3d3c42e5… # v7.0.1`.",
  },
  "pr-target-checkout": {
    why: "`pull_request_target` runs with the base repository's secrets and a write-capable token. Bringing PR-controlled content into that job is the classic pwn-request.",
    fix: "Check out the base ref only, or handle PR content as inert bytes fetched by a trusted scanner that never executes it.",
  },
  "pr-target-artifact-download": {
    why: "An artifact from a PR-triggered run is attacker-authored data unpacked inside a privileged job; path traversal and later execution both follow from it.",
    fix: "Do not download PR artifacts in a `pull_request_target` job. Move the consumer to an unprivileged `pull_request` job, or to a trusted service.",
  },
  "pr-target-package-install": {
    why: "A package manager in a `pull_request_target` job executes attacker-controlled lockfiles, manifests, lifecycle scripts, and build files with the base repository's secrets in scope.",
    fix: "Remove the install/build from the privileged job. Anything that must run PR code belongs in a `pull_request` job with no secrets.",
  },
  "pr-target-dynamic-run": {
    why: "Interpolating `${{ github.event.* }}` / `${{ github.head_ref }}` straight into a shell or script body is command injection: a PR title or branch name becomes code in a privileged job.",
    fix: 'Pass the value through `env:` and reference it as a shell/JS variable (`"$PR_TITLE"`, `process.env.PR_TITLE`) so it is never expanded into the program text.',
  },
  "allowlist-entry-invalid": {
    why: "An unaccountable waiver is a silent policy change. Every entry must name one rule, one owner, and a justification a reviewer can judge.",
    fix: "Give the entry a `rule` from this catalogue, a non-empty `owner`, and a `justification` of at least 40 characters naming the follow-up that removes it.",
  },
};

export const PR_LIKE_EVENTS = [
  "pull_request",
  "pull_request_target",
  "pull_request_review",
  "pull_request_review_comment",
  "issue_comment",
];

const SECRET_REF = /\bsecrets\s*(?:\.\s*([A-Za-z_][\w-]*)|\[)/g;
// `github.event.` with the trailing dot: `github.event_name` is a fixed trigger name, not input.
const ATTACKER_EXPR = /\bgithub\s*\.\s*(?:event\s*\.|head_ref\b)/;
const PR_REF_HINT = /\bgithub\s*\.\s*(?:event\s*\.|head_ref\b)|refs\/pull\//;
const PR_FETCH_RUN =
  /\bgh\s+pr\s+checkout\b|\bgit\s+fetch\b[^\n]*refs\/pull\/|(?:api\.github\.com|codeload\.github\.com)[^\s"']*\/(?:tarball|zipball|legacy)\b/;
const ARTIFACT_RUN = /\bgh\s+run\s+download\b|\/actions\/runs\/[^\s"']*\/artifacts\b/;
// Deliberately broader than "install": in a pull_request_target job, running the PR's own scripts,
// lockfile lifecycle hooks, or build files is the exploit primitive, not just fetching packages.
const PACKAGE_INSTALL_RUN =
  /(?:^|[\s;&|(`])(?:npm\s+(?:ci|install|i|exec|run)|npx\s|yarn(?:\s|$)|pnpm(?:\s|$)|bun\s+(?:install|run)|pip3?\s+install|poetry\s+install|bundle\s+install|composer\s+install|go\s+(?:mod\s+download|get)|cargo\s+(?:build|test|run|install)|mvn(?:\s|$)|\.?\/?gradlew?(?:\s|$)|make(?:\s|$))/;

const isMap = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const lineOf = (node, key) => node?.$keyLines?.[key] ?? node?.$line ?? 0;

/** GitHub expressions are the only place `secrets` / `github.*` mean anything. */
function expressionsIn(value) {
  return [...String(value).matchAll(/\$\{\{([\s\S]*?)\}\}/g)].map((m) => m[1]);
}

/** Trigger names of a workflow's `on:`, whatever shape it takes (string, list, or map). */
export function triggersOf(doc) {
  const on = doc?.on;
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on.filter((t) => typeof t === "string");
  if (isMap(on)) return Object.keys(on);
  return [];
}

/** `workflow_run` edge: reachable when any named upstream is PR-like or cannot be resolved. */
function workflowRunReason(on, byName, reasons) {
  const upstream = isMap(on.workflow_run) ? on.workflow_run.workflows : null;
  if (!Array.isArray(upstream) || upstream.length === 0)
    return "workflow_run with no `workflows:` filter — any upstream, treated as PR-like";
  for (const name of upstream) {
    const src = byName.get(String(name));
    if (!src) return `workflow_run of unresolved workflow "${name}" (fail-closed)`;
    if (reasons.has(src.rel)) return `workflow_run of PR-like "${name}"`;
  }
  return null;
}

/** `workflow_call` edge: a reusable workflow inherits its caller's trigger, so it inherits risk. */
function workflowCallReason(file, files, reasons) {
  const basename = path.basename(file.rel);
  for (const caller of files) {
    if (caller.error || !reasons.has(caller.rel)) continue;
    for (const [jobId, job] of Object.entries(caller.doc.jobs ?? {})) {
      const ref = isMap(job) ? job.uses : null;
      if (
        typeof ref === "string" &&
        ref.replace(/^\.\//, "").startsWith(`.github/workflows/${basename}`)
      )
        return `called by PR-like ${caller.rel} (job \`${jobId}\`)`;
    }
  }
  return null;
}

/**
 * Which workflows a PR-like event can reach. Fail-closed at every unknown edge: an unparseable
 * file, a `workflow_run` with no resolvable upstream, and a `workflow_call` file called by a
 * reachable caller all count as reachable.
 * @returns {Map<string, string>} relative path → the reason it is reachable
 */
export function computeReachability(files) {
  const reasons = new Map();
  const byName = new Map();
  for (const f of files) if (f.doc?.name) byName.set(String(f.doc.name), f);

  for (const f of files) {
    if (f.error) {
      reasons.set(f.rel, "could not be parsed — treated as reachable");
      continue;
    }
    const hit = triggersOf(f.doc).filter((t) => PR_LIKE_EVENTS.includes(t));
    if (hit.length) reasons.set(f.rel, hit.join(", "));
  }

  // Transitive edges need a fixpoint: a workflow_run of a workflow_call of a pull_request job.
  for (let pass = 0; pass <= files.length; pass++) {
    let grew = false;
    for (const f of files) {
      if (f.error || reasons.has(f.rel)) continue;
      const on = isMap(f.doc.on) ? f.doc.on : {};
      const reason =
        ("workflow_run" in on ? workflowRunReason(on, byName, reasons) : null) ??
        ("workflow_call" in on ? workflowCallReason(f, files, reasons) : null);
      if (reason) {
        reasons.set(f.rel, reason);
        grew = true;
      }
    }
    if (!grew) break;
  }
  return reasons;
}

/** Scalars belonging to the workflow scope (everything above `jobs:`). */
function* workflowScalars(doc) {
  for (const [key, value] of Object.entries(doc)) {
    if (key === "jobs") continue;
    yield* walkScalars(value, key, lineOf(doc, key));
  }
}

function elevatedPermissions(perms, permsLine) {
  if (perms === null || perms === undefined) return [];
  if (typeof perms === "string")
    return perms.trim() === "write-all"
      ? [
          {
            detail: "`permissions: write-all` grants checks:write and statuses:write",
            line: permsLine,
          },
        ]
      : [];
  if (!isMap(perms))
    return [{ detail: `unrecognized \`permissions:\` shape (${typeof perms})`, line: permsLine }];
  return ["checks", "statuses"]
    .filter((scope) => String(perms[scope]) === "write")
    .map((scope) => ({ detail: `\`${scope}: write\``, line: lineOf(perms, scope) || permsLine }));
}

/** Classify one `uses:` ref. Returns a message when it is not immutably pinned. */
export function mutableUsesRef(ref) {
  if (typeof ref !== "string") return null;
  const value = ref.trim();
  if (value === "") return "empty `uses:`";
  if (value.startsWith("./") || value.startsWith("../")) return null; // travels with the commit
  if (value.startsWith("docker://"))
    return /@sha256:[0-9a-f]{64}$/.test(value) ? null : "docker image is not digest-pinned";
  const at = value.lastIndexOf("@");
  if (at <= 0) return "`uses:` carries no `@ref` at all";
  const pinned = value.slice(at + 1);
  if (!/^[0-9a-f]{40}$/.test(pinned))
    return `\`${pinned}\` is a mutable ref, not a 40-hex commit SHA`;
  return null;
}

function stepLabel(step, index) {
  const name =
    typeof step?.name === "string" ? step.name : typeof step?.uses === "string" ? step.uses : null;
  return name ? `step ${index + 1} (${name})` : `step ${index + 1}`;
}

/** `secrets.*` and the App-owned status context, over one scope's scalars. */
function auditScope(jobId, scalars, add) {
  const seenSecrets = new Set();
  for (const { value, line } of scalars) {
    for (const expression of expressionsIn(value)) {
      for (const m of expression.matchAll(SECRET_REF)) {
        const name = m[1] ?? "<computed>";
        if (seenSecrets.has(name)) continue;
        seenSecrets.add(name);
        add(jobId, "secrets-in-pr-reachable", line, `reads \`secrets.${name}\``);
      }
    }
    if (/AIOS\s+Security\s+Gate/i.test(value))
      add(jobId, "security-gate-context", line, "names the `AIOS Security Gate` status context");
  }
}

/** The four facets of the plan's `pull_request_target` rule, for one step. */
function auditPrTargetStep(jobId, step, label, stepLine, add) {
  const uses = typeof step.uses === "string" ? step.uses : "";
  const withBlock = isMap(step.with) ? step.with : {};
  const run = typeof step.run === "string" ? step.run : "";
  const script = typeof withBlock.script === "string" ? withBlock.script : "";
  const checkoutInputs = [withBlock.ref, withBlock.repository].filter((v) => typeof v === "string");

  if (/(^|\/)checkout@/.test(uses) && checkoutInputs.some((v) => PR_REF_HINT.test(v)))
    add(
      jobId,
      "pr-target-checkout",
      lineOf(withBlock, "ref") || stepLine,
      `${label}: checks out PR-controlled ref`
    );
  if (PR_FETCH_RUN.test(run))
    add(
      jobId,
      "pr-target-checkout",
      lineOf(step, "run") || stepLine,
      `${label}: \`run:\` fetches PR-controlled content`
    );
  if (/download-artifact/.test(uses) || ARTIFACT_RUN.test(run))
    add(
      jobId,
      "pr-target-artifact-download",
      lineOf(step, "uses") || lineOf(step, "run") || stepLine,
      `${label}: downloads a workflow artifact`
    );
  if (PACKAGE_INSTALL_RUN.test(run))
    add(
      jobId,
      "pr-target-package-install",
      lineOf(step, "run") || stepLine,
      `${label}: \`run:\` invokes a package manager or build tool`
    );
  for (const [key, body] of [
    ["run", run],
    ["with.script", script],
  ]) {
    const hit = expressionsIn(body).find((e) => ATTACKER_EXPR.test(e));
    if (hit)
      add(
        jobId,
        "pr-target-dynamic-run",
        lineOf(step, key === "run" ? "run" : "with") || stepLine,
        `${label}: \`${key}:\` interpolates \`\${{${hit.trim()}}}\``
      );
  }
}

function auditJob(jobId, job, jobLine, isPrTarget, add) {
  for (const violation of elevatedPermissions(job.permissions, lineOf(job, "permissions")))
    add(jobId, "elevated-permissions", violation.line, violation.detail);

  const jobUses = mutableUsesRef(job.uses);
  if (jobUses)
    add(jobId, "mutable-action-ref", lineOf(job, "uses"), `\`uses: ${job.uses}\` — ${jobUses}`);

  auditScope(jobId, walkScalars(job, `jobs.${jobId}`, jobLine), add);

  for (const [index, step] of (Array.isArray(job.steps) ? job.steps : []).entries()) {
    if (!isMap(step)) continue;
    const label = stepLabel(step, index);
    const stepLine = step.$line ?? lineOf(job, "steps");
    const problem = mutableUsesRef(step.uses);
    if (problem)
      add(
        jobId,
        "mutable-action-ref",
        lineOf(step, "uses") || stepLine,
        `${label}: \`uses: ${step.uses}\` — ${problem}`
      );
    if (isPrTarget) auditPrTargetStep(jobId, step, label, stepLine, add);
  }
}

/**
 * Every rule that applies to one PR-reachable workflow.
 * @returns {Array<{file: string, job: string, rule: string, line: number, detail: string}>}
 */
export function auditWorkflow(file) {
  const found = [];
  const doc = file.doc;
  const add = (job, rule, line, detail) => found.push({ file: file.rel, job, rule, line, detail });

  auditScope("(workflow)", workflowScalars(doc), add);
  for (const violation of elevatedPermissions(doc.permissions, lineOf(doc, "permissions")))
    add("(workflow)", "elevated-permissions", violation.line, violation.detail);

  const jobs = isMap(doc.jobs) ? doc.jobs : {};
  const isPrTarget = triggersOf(doc).includes("pull_request_target");
  for (const [jobId, job] of Object.entries(jobs)) {
    if (isMap(job)) auditJob(jobId, job, lineOf(jobs, jobId), isPrTarget, add);
  }
  return found;
}

/** A justification shorter than this is a placeholder, not a reviewed decision. */
export const MIN_JUSTIFICATION = 40;

function entryProblems(entry) {
  const problems = [];
  if (typeof entry?.workflow !== "string" || entry.workflow.trim() === "")
    problems.push("`workflow` must be a repo-relative path");
  if (typeof entry?.job !== "string" || entry.job.trim() === "")
    problems.push('`job` must be a job id, or "*" for every job in that one file');
  if (typeof entry?.rule !== "string" || !Object.hasOwn(RULES, entry.rule))
    problems.push(
      `\`rule\` must be one of: ${Object.keys(RULES).join(", ")} (a blanket waiver is not expressible)`
    );
  if (typeof entry?.owner !== "string" || entry.owner.trim() === "")
    problems.push("`owner` must name an accountable person or team");
  if (
    typeof entry?.justification !== "string" ||
    entry.justification.trim().length < MIN_JUSTIFICATION
  )
    problems.push(
      `\`justification\` must be at least ${MIN_JUSTIFICATION} characters and name the follow-up that removes this waiver`
    );
  return problems;
}

/** Validate the waiver file. Returns { entries, findings } — a bad entry is itself a violation. */
export function validateAllowlist(raw, file) {
  const findings = [];
  const entries = [];
  const invalid = (detail) =>
    findings.push({ file, job: "(allowlist)", rule: "allowlist-entry-invalid", line: 0, detail });
  const list = Array.isArray(raw?.entries) ? raw.entries : null;
  if (!list) {
    invalid("the allowlist must be an object with an `entries` array");
    return { entries, findings };
  }
  for (const [index, entry] of list.entries()) {
    const problems = entryProblems(entry);
    if (problems.length) invalid(`entry #${index + 1}: ${problems.join("; ")}`);
    else entries.push({ ...entry, used: false });
  }
  return { entries, findings };
}

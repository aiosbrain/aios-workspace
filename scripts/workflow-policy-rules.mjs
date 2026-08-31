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
import { PR_LIKE_EVENTS } from "./workflow-policy-catalogue.mjs";
import {
  ALL_INPUTS_TAINTED,
  ALWAYS_PR_FETCH,
  ARCHIVE_PRIMITIVE,
  FETCH_PRIMITIVE,
  expressionsIn,
  prControlledRef,
  taintedExpression,
  taintedVarsFrom,
  untrustedResidual,
} from "./workflow-policy-expressions.mjs";

// Re-exported so callers keep one import site for the whole policy surface, even though the
// catalogue and the waiver validator are now their own modules.
export { MIN_JUSTIFICATION, PR_LIKE_EVENTS, RULES } from "./workflow-policy-catalogue.mjs";
export { validateAllowlist } from "./workflow-policy-allowlist.mjs";

const SECRET_REF = /\bsecrets\s*(?:\.\s*([A-Za-z_][\w-]*)|\[)/g;
const ARTIFACT_RUN = /\bgh\s+run\s+download\b|\/actions\/runs\/[^\s"']*\/artifacts\b/;
// Deliberately broader than "install": in a pull_request_target job, running the PR's own scripts,
// lockfile lifecycle hooks, or build files is the exploit primitive, not just fetching packages.
const PACKAGE_INSTALL_RUN =
  /(?:^|[\s;&|(`])(?:npm\s+(?:ci|install|i|exec|run)|npx\s|yarn(?:\s|$)|pnpm(?:\s|$)|bun\s+(?:install|run)|pip3?\s+install|poetry\s+install|bundle\s+install|composer\s+install|go\s+(?:mod\s+download|get)|cargo\s+(?:build|test|run|install)|mvn(?:\s|$)|\.?\/?gradlew?(?:\s|$)|make(?:\s|$))/;

const isMap = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const lineOf = (node, key) => node?.$keyLines?.[key] ?? node?.$line ?? 0;

/** Trigger names of a workflow's `on:`, whatever shape it takes (string, list, or map). */
export function triggersOf(doc) {
  const on = doc?.on;
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on.filter((t) => typeof t === "string");
  if (isMap(on)) return Object.keys(on);
  return [];
}

/**
 * `workflow_run` edge: reachable when any named upstream is PR-like or cannot be resolved.
 * Returns the reach record to INHERIT, so a `pull_request_target` origin propagates downstream.
 */
function workflowRunReach(on, byName, reach) {
  const upstream = isMap(on.workflow_run) ? on.workflow_run.workflows : null;
  // No `workflows:` filter means every workflow in the repo is an upstream, including a
  // pull_request_target one — fail closed on BOTH reachability and the PR-target origin.
  if (!Array.isArray(upstream) || upstream.length === 0)
    return {
      reason: "workflow_run with no `workflows:` filter — any upstream, treated as PR-target",
      prTarget: true,
    };
  let found = null;
  for (const name of upstream) {
    // `workflows:` matches by NAME, and nothing stops two files sharing one `name:`. GitHub runs
    // the downstream for EITHER of them, so every candidate has to be considered and the strongest
    // reachability wins. A last-write-wins lookup here silently misclassified the downstream as
    // unreachable whenever the discarded twin was the PR-reachable one — and an unreachable file is
    // one no rule runs against at all.
    const candidates = byName.get(String(name)) ?? [];
    if (candidates.length === 0)
      return {
        reason: `workflow_run of unresolved workflow "${name}" (fail-closed)`,
        prTarget: true,
      };
    for (const src of candidates) {
      const up = reach.get(src.rel);
      if (!up) continue;
      // Keep looking for a pull_request_target origin: "any path" is what decides the audit.
      if (up.prTarget)
        return { reason: `workflow_run of pull_request_target "${name}"`, prTarget: true };
      found ??= { reason: `workflow_run of PR-like "${name}"`, prTarget: false };
    }
  }
  return found;
}

/**
 * `workflow_call` edge: a local reusable workflow declares `on: workflow_call`, but it EXECUTES
 * with the caller's event context and privileges. Its own `on:` block therefore says nothing about
 * whether the PR-target rules apply — the caller's origin does. Deriving that from the callee is
 * the bypass this function exists to close: move a privileged step into a reusable workflow called
 * from a `pull_request_target` workflow and every pr-target rule would otherwise go unchecked.
 *
 * Returns the reach record to INHERIT, preferring a `pull_request_target` caller when several
 * callers reach the same file.
 */
function workflowCallReach(file, files, reach) {
  const basename = path.basename(file.rel);
  let found = null;
  for (const caller of files) {
    if (caller.error) continue;
    const via = reach.get(caller.rel);
    if (!via) continue;
    for (const [jobId, job] of Object.entries(caller.doc.jobs ?? {})) {
      const ref = isMap(job) ? job.uses : null;
      if (
        typeof ref !== "string" ||
        !ref.replace(/^\.\//, "").startsWith(`.github/workflows/${basename}`)
      )
        continue;
      const origin = via.prTarget ? "pull_request_target" : "PR-like";
      const record = {
        reason: `called by ${origin} ${caller.rel} (job \`${jobId}\`)`,
        prTarget: via.prTarget,
      };
      if (via.prTarget) return record; // strongest origin wins immediately
      found ??= record;
    }
  }
  return found;
}

/**
 * Which workflows a PR-like event can reach, and — separately — whether any path that reaches each
 * one ORIGINATES from `pull_request_target`. The second half is load-bearing: the pr-target rules
 * must be judged on the originating trigger, never on the audited file's own `on:` block, or a
 * local reusable workflow launders every one of them.
 *
 * Fail-closed at every unknown edge: an unparseable file, a `workflow_run` with no resolvable
 * upstream, and a `workflow_call` file called by a reachable caller all count as reachable, and the
 * unresolvable ones count as `pull_request_target` too.
 *
 * @returns {Map<string, {reason: string, prTarget: boolean}>} relative path → how it is reached
 */
export function computeReachability(files) {
  const reach = new Map();
  // Every file per name, never the last one wins — see workflowRunReach.
  const byName = new Map();
  for (const f of files) {
    if (!f.doc?.name) continue;
    const key = String(f.doc.name);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(f);
  }

  // An origin may be discovered AFTER a file is first marked reachable (caller A is `pull_request`,
  // caller B is `pull_request_target`, and B is only reached on a later pass). A false→true upgrade
  // therefore counts as progress, or the strongest origin could be missed.
  const record = (rel, next) => {
    const current = reach.get(rel);
    if (!current) {
      reach.set(rel, next);
      return true;
    }
    if (next.prTarget && !current.prTarget) {
      reach.set(rel, next);
      return true;
    }
    return false;
  };

  for (const f of files) {
    if (f.error) {
      record(f.rel, { reason: "could not be parsed — treated as reachable", prTarget: true });
      continue;
    }
    const hit = triggersOf(f.doc).filter((t) => PR_LIKE_EVENTS.includes(t));
    if (hit.length)
      record(f.rel, { reason: hit.join(", "), prTarget: hit.includes("pull_request_target") });
  }

  // Fixpoint over the transitive edges. Each file can be added once and upgraded once, so the
  // number of productive passes is bounded by 2n; the loop exits as soon as a pass changes nothing.
  for (let pass = 0; pass <= 2 * files.length + 1; pass++) {
    let grew = false;
    for (const f of files) {
      if (f.error) continue;
      const on = isMap(f.doc.on) ? f.doc.on : {};
      const next =
        ("workflow_run" in on ? workflowRunReach(on, byName, reach) : null) ??
        ("workflow_call" in on ? workflowCallReach(f, files, reach) : null);
      if (next && record(f.rel, next)) grew = true;
    }
    if (!grew) break;
  }
  return reach;
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

/**
 * Every way this step brings PR-controlled content into a privileged job, as {line, detail}.
 * Extracted from auditPrTargetStep so each rule family stays independently readable — and so the
 * acquisition logic, which is the part that has already regressed twice, sits on its own.
 */
function prContentAcquisition(step, tainted, stepLine) {
  const out = [];
  const uses = typeof step.uses === "string" ? step.uses : "";
  const withBlock = isMap(step.with) ? step.with : {};
  const run = typeof step.run === "string" ? step.run : "";
  const inputs = [withBlock.ref, withBlock.repository].filter((v) => typeof v === "string");
  const runLine = lineOf(step, "run") || stepLine;

  const untrustedInput = (v) =>
    /refs\/pull\//.test(untrustedResidual(v)) || taintedExpression(v, tainted) !== null;
  if (/(^|\/)checkout@/.test(uses) && inputs.some(untrustedInput))
    out.push({
      line: lineOf(withBlock, "ref") || stepLine,
      detail: "checks out PR-controlled ref",
    });

  // Fast path: a command that names the pull request itself needs no correlating reference.
  if (ALWAYS_PR_FETCH.test(run)) {
    out.push({ line: runLine, detail: "`run:` checks out the pull request" });
    return out;
  }
  const ref = prControlledRef(run, tainted);
  if (ref && (FETCH_PRIMITIVE.test(run) || ARCHIVE_PRIMITIVE.test(run)))
    out.push({ line: runLine, detail: `\`run:\` fetches or extracts content selected by ${ref}` });
  return out;
}

/** The four facets of the plan's `pull_request_target` rule, for one step. */
function auditPrTargetStep(step, ctx) {
  const { jobId, label, stepLine, add } = ctx;
  const uses = typeof step.uses === "string" ? step.uses : "";
  const withBlock = isMap(step.with) ? step.with : {};
  const run = typeof step.run === "string" ? step.run : "";
  const script = typeof withBlock.script === "string" ? withBlock.script : "";
  const tainted = taintedVarsFrom(step.env, ctx.tainted);
  const runLine = lineOf(step, "run") || stepLine;

  for (const { line, detail } of prContentAcquisition(step, tainted, stepLine))
    add(jobId, "pr-target-checkout", line, `${label}: ${detail}`);

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
      runLine,
      `${label}: \`run:\` invokes a package manager or build tool`
    );
  for (const [key, body] of [
    ["run", run],
    ["with.script", script],
  ]) {
    const hit = taintedExpression(body, tainted);
    if (hit)
      add(
        jobId,
        "pr-target-dynamic-run",
        lineOf(step, key === "run" ? "run" : "with") || stepLine,
        `${label}: \`${key}:\` interpolates \`\${{${hit}}}\``
      );
  }
}

function auditJob(jobId, job, ctx) {
  const { jobLine, isPrTarget, add } = ctx;
  const tainted = taintedVarsFrom(job.env, ctx.tainted);
  for (const violation of elevatedPermissions(job.permissions, lineOf(job, "permissions")))
    add(jobId, "elevated-permissions", violation.line, violation.detail);

  const jobUses = mutableUsesRef(job.uses);
  if (jobUses)
    add(jobId, "mutable-action-ref", lineOf(job, "uses"), `\`uses: ${job.uses}\` — ${jobUses}`);

  // `secrets: inherit` hands the callee EVERY secret the caller holds while containing no
  // `secrets.*` expression anywhere, so the scalar walk below sees nothing. A caller job that
  // passes it typically has no `steps` either, so without this the whole caller/callee pair
  // vanishes from the report. The map form (`secrets: {NAME: ${{ secrets.NAME }}}`) needs no
  // special case — those ARE expressions, and auditScope catches them.
  if (typeof job.secrets === "string" && job.secrets.trim() === "inherit")
    add(
      jobId,
      "secrets-in-pr-reachable",
      lineOf(job, "secrets"),
      "`secrets: inherit` passes every caller secret to this job"
    );

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
    if (isPrTarget) auditPrTargetStep(step, { jobId, label, stepLine, add, tainted });
  }
}

/**
 * Every rule that applies to one PR-reachable workflow.
 *
 * `prTarget` is the ORIGIN of the path that reaches this file (from computeReachability), not the
 * file's own trigger. A local reusable workflow declares `on: workflow_call` yet runs with its
 * caller's `pull_request_target` privileges, so deriving this from `doc.on` here would let any
 * privileged step be laundered through a `uses: ./.github/workflows/...` call.
 *
 * @returns {Array<{file: string, job: string, rule: string, line: number, detail: string}>}
 */
export function auditWorkflow(file, prTarget = false) {
  const found = [];
  const doc = file.doc;
  const add = (job, rule, line, detail) => found.push({ file: file.rel, job, rule, line, detail });

  auditScope("(workflow)", workflowScalars(doc), add);
  for (const violation of elevatedPermissions(doc.permissions, lineOf(doc, "permissions")))
    add("(workflow)", "elevated-permissions", violation.line, violation.detail);

  const jobs = isMap(doc.jobs) ? doc.jobs : {};
  // Belt and braces: the file's own trigger can only ADD to the propagated origin, never clear it.
  const isPrTarget = prTarget || triggersOf(doc).includes("pull_request_target");
  // A workflow_call callee running under a pull_request_target origin gets its `inputs` from the
  // caller, and cross-file `with:` dataflow is not modelled here. Seed the taint set so every
  // `${{ inputs.* }}` counts as PR-controlled rather than silently assumed safe.
  const seed = new Set();
  if (isPrTarget && triggersOf(doc).includes("workflow_call")) seed.add(ALL_INPUTS_TAINTED);
  const tainted = taintedVarsFrom(doc.env, seed);
  for (const [jobId, job] of Object.entries(jobs)) {
    if (isMap(job))
      auditJob(jobId, job, { jobLine: lineOf(jobs, jobId), isPrTarget, add, tainted });
  }
  return found;
}

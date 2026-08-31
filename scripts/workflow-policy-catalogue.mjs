/**
 * workflow-policy-catalogue.mjs — the rule catalogue and the constants that define the policy's
 * SCOPE, for scripts/check-workflow-policy.mjs (leak-gate-remediation-plan.md §5.1 item 3).
 *
 * Pure data with no imports: the reporting layer, the audit layer, and the allowlist validator all
 * need these, and keeping them dependency-free means none of those three can import each other
 * just to reach a rule description. Split out of workflow-policy-rules.mjs when that file passed
 * the 500-line cap.
 */
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

/**
 * A justification shorter than this is a placeholder, not a reviewed decision. Deliberately long
 * enough that "WIP", "temporary" or a bare ticket id cannot satisfy it.
 */
export const MIN_JUSTIFICATION = 40;

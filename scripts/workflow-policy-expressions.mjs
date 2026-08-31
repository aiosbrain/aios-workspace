/**
 * workflow-policy-expressions.mjs — what counts as ATTACKER-CONTROLLED, for
 * scripts/check-workflow-policy.mjs (leak-gate-remediation-plan.md §5.1 item 3).
 *
 * This is the module that decides, for a `pull_request_target` job, whether a value came from the
 * pull request. Every bypass found in adversarial review of this gate has originated here — an
 * endpoint blocklist that missed `tar.gz`, and taint that followed `$SHELL_VAR` but not
 * `${{ env.VAR }}` — so it is kept as one small, separately readable unit rather than buried among
 * the rule plumbing. Zero imports: it reasons about strings, not about workflow structure.
 *
 * The two halves that carry the guarantee:
 *   - `untrustedResidual` blanks the ONLY provably-safe fields, so everything unproven stays
 *     untrusted by default (an allowlist, never a blocklist);
 *   - `taintedExpression` resolves the indirect forms — `${{ env.X }}` through the taint set, and
 *     `${{ inputs.X }}` on a callee whose caller is a pull_request_target workflow.
 */

// `github.event.` with the trailing dot: `github.event_name` is a fixed trigger name, not input.
export const ATTACKER_EXPR = /\bgithub\s*\.\s*(?:event\s*\.|head_ref\b)/;

// ── PR-controlled content acquisition, judged by CONSTRUCTION not by endpoint ────────────────
//
// This rule used to enumerate known-bad endpoints: `api.github.com/…/tarball`,
// `codeload.github.com/…/zipball`, and `git fetch … refs/pull/`. That is the wrong shape for a
// security boundary and it leaked — `codeload.github.com/o/r/tar.gz/refs/pull/123/head` matched
// none of them, because the path segment is `tar.gz` rather than `tarball|zipball|legacy`.
// `raw.githubusercontent.com`, `git archive --remote`, `wget`, a `$GITHUB_SERVER_URL`-built URL and
// a bare `git fetch <sha>` are all the same attack, and each would have needed its own alternative:
// one reviewer finds one hole, the next reviewer finds the next.
//
// It is now a CONJUNCTION — any transport or archive primitive, together with any PR-controlled
// reference reaching the same `run:` body. The primitive lists may be incomplete only in the safe
// direction (a missing primitive is a miss, never a silent pass on a listed one); the REFERENCE
// side is what carries the guarantee, and it defaults to "flag" whenever the ref cannot be shown
// to be trusted. A false positive here is waivable with an owner and a justification; a false
// negative is the bug this whole gate exists to prevent.
export const FETCH_PRIMITIVE =
  /(?:^|[\s;&|(`$\/])(?:curl|wget|aria2c|http|https|scp|rsync|ftp|svn|hg|nc|gh\s+api|gh\s+release\s+download|gh\s+repo\s+clone|git\s+(?:fetch|clone|pull|archive|checkout|remote|ls-remote)|npm\s+pack|pip3?\s+download|go\s+get)\b/;
export const ARCHIVE_PRIMITIVE =
  /(?:^|[\s;&|(`\/])(?:tar|bsdtar|unzip|gunzip|unxz|zstd|7z|jar|cpio)\b/;
// Self-contained PR checkouts: the command names the pull request itself, so there is no second
// reference to correlate and the conjunction does not apply.
export const ALWAYS_PR_FETCH = /\bgh\s+pr\s+(?:checkout|diff)\b/;
// `$GITHUB_EVENT_PATH` is the entire webhook payload on disk. Reading it is a PR-controlled read
// even when no `${{ }}` expression appears anywhere in the body.
export const IMPLICITLY_TAINTED_VARS = ["GITHUB_EVENT_PATH"];
// Only well-formed shell identifiers are turned into a `$NAME` matcher.
export const SHELL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// A reusable workflow reached from pull_request_target receives its `inputs` from the caller, and
// this gate does not model cross-file `with:` dataflow. Rather than assume those inputs are safe,
// a callee in that position treats EVERY `inputs.*` as tainted — the same default-to-flag posture
// the rest of the acquisition rule takes. Not a shell name, so it can never collide with a real
// env var in the taint set.
export const ALL_INPUTS_TAINTED = "*inputs*";

// The ONLY expression fields that are provably not attacker-controlled: the base branch's commit
// and name, and the repository default branch. Everything else under `github.event.*` — including
// `head.*`, `merge_commit_sha`, and `number` (which composes into `refs/pull/<n>/head`) — stays
// untrusted. This is an allowlist of proven-safe fields, deliberately not a blocklist of unsafe
// ones: a field nobody has reasoned about defaults to untrusted, so "check out the base ref only"
// (this rule's own remediation advice) does not itself get flagged.
export const TRUSTED_REF_FIELD =
  /github\s*\.\s*event\s*\.\s*(?:pull_request\s*\.\s*base\s*\.\s*(?:sha|ref)\b|repository\s*\.\s*default_branch\b)/g;

// GitHub expressions index a context two ways: `env.NAME` and `env['NAME']` (double quotes and
// interior whitespace are equally legal). Every context supports both — `github['event']`,
// `inputs["x"]`, `secrets['x']` — so matching only the dot form leaves the identical hole one
// context over. Normalizing the literal-string form into dot notation means ONE set of patterns
// covers both syntaxes and no future rule can forget the bracket case.
const BRACKET_LITERAL_INDEX = /\[\s*(?:'([^']*)'|"([^"]*)")\s*\]/g;

/** `a['b']["c"]` -> `a.b.c`, so the dot-notation patterns below see one canonical form. */
export function normalizeExpression(text) {
  let out = String(text);
  // Repeat to fold chains: `github['event']['pull_request']` needs more than one pass only when a
  // replacement creates a newly adjacent bracket, which it does not — but the loop is cheap and
  // makes the property "no bracket literal survives" true by construction rather than by argument.
  for (let pass = 0; pass < 8; pass++) {
    const next = out.replace(BRACKET_LITERAL_INDEX, (_, single, double) => `.${single ?? double}`);
    if (next === out) break;
    out = next;
  }
  return out;
}

// A bracket index that is NOT a plain string literal — `env[format(...)]`, `env[matrix.key]` — is
// unresolvable by static analysis. It cannot be proven safe, so it is treated as attacker-
// controlled, consistent with the default-to-flag posture everywhere else in this module.
const UNRESOLVABLE_INDEX = /\b(?:env|github|inputs|secrets|needs|steps|vars|matrix)\s*\[/;

/** Blank out provably-trusted field references so only unproven ones remain to be judged. */
export function untrustedResidual(text) {
  return String(text).replace(TRUSTED_REF_FIELD, "trusted_base_ref");
}

/** GitHub expressions are the only place `secrets` / `github.*` mean anything. */
export function expressionsIn(value) {
  return [...String(value).matchAll(/\$\{\{([\s\S]*?)\}\}/g)].map((m) => m[1]);
}

/**
 * How a `${{ }}` expression in `text` is attacker-controlled, or null.
 *
 * Beyond a direct `github.event.*` / `github.head_ref` reference this resolves the INDIRECT form
 * `${{ env.NAME }}`, which the Actions expression evaluator substitutes before the shell ever runs
 * — so it is the more direct injection of the two, not a lesser one. Missing it meant a job could
 * map `HEAD_SHA: ${{ …head.sha }}` at job scope and then use `ref: ${{ env.HEAD_SHA }}`, checking
 * out attacker code with nothing in the step matching any pattern.
 *
 * `untrustedResidual` runs first, so a name carrying only `pull_request.base.sha` never taints.
 */
// A job or step OUTPUT is opaque to static analysis: its value is produced at runtime by a
// `run:` body we cannot evaluate, and in a `pull_request_target` job that body routinely derives
// from the pull request. `${{ steps.p.outputs.ref }}` and `${{ needs.prepare.outputs.ref }}` are
// therefore laundering channels for exactly the taint this module tracks, and neither resolves
// statically. Same conservative default as UNRESOLVABLE_INDEX: cannot prove trusted, so treat as
// tainted. A privileged job that genuinely needs a computed ref is a waiver with a justification,
// not a silent pass.
const OPAQUE_OUTPUT =
  /\b(?:steps|needs)\s*\.\s*[A-Za-z_][\w-]*\s*\.\s*outputs\s*\.\s*[A-Za-z_][\w-]*/;

export function taintedExpression(text, tainted) {
  for (const raw of expressionsIn(String(text))) {
    // Normalize FIRST, then blank trusted fields: `github['event']['pull_request']['base']['sha']`
    // has to fold to dot notation before the trusted-field allowlist can recognise it.
    const expression = untrustedResidual(normalizeExpression(raw));
    if (UNRESOLVABLE_INDEX.test(expression)) return raw.trim();
    if (OPAQUE_OUTPUT.test(expression)) return raw.trim();
    if (ATTACKER_EXPR.test(expression)) return raw.trim();
    if (tainted.has(ALL_INPUTS_TAINTED) && /\binputs\s*\./.test(expression)) return raw.trim();
    for (const name of [...tainted, ...IMPLICITLY_TAINTED_VARS]) {
      if (SHELL_NAME.test(name) && new RegExp(`\\benv\\s*\\.\\s*${name}\\b`).test(expression))
        return raw.trim();
    }
  }
  return null;
}

/**
 * Env names whose value interpolates an attacker-controlled expression, unioned with whatever the
 * enclosing scope already tainted. This is what closes the `env:` indirection: leak-gate.yml maps
 * `HEAD_SHA: ${{ github.event.pull_request.head.sha }}` and then curls `"$HEAD_SHA"`, so the run
 * body contains no `${{ }}` at all and an expression-only check would see nothing.
 */
export function taintedVarsFrom(env, inherited = new Set()) {
  if (!env || typeof env !== "object" || Array.isArray(env)) return new Set(inherited);
  const local = new Map(Object.entries(env).filter(([name]) => SHELL_NAME.test(name)));
  // PRECEDENCE, not union: a name redefined in this scope is decided by THIS scope's value, so a
  // step-level `FOO: literal` untaints a tainted job-level `FOO`, and the reverse taints it. A
  // blind union would make shadowing a one-way ratchet and produce false positives that nobody
  // could clear without deleting the outer variable.
  const out = new Set([...inherited].filter((name) => !local.has(name)));
  // Monotone fixpoint so an intra-scope chain (`B: ${{ env.A }}` declared before `A`) still
  // resolves. Only ever adds, so it terminates in at most one pass per entry.
  for (let pass = 0; pass <= local.size; pass++) {
    let changed = false;
    for (const [name, value] of local) {
      if (out.has(name) || typeof value !== "string") continue;
      if (taintedExpression(value, out)) {
        out.add(name);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return out;
}

/**
 * How a `run:` body references PR-controlled content, or null if it demonstrably does not.
 * Deliberately generous: an unprovable reference resolves to flagged.
 */
export function prControlledRef(body, tainted) {
  if (/refs\/pull\//.test(untrustedResidual(normalizeExpression(body))))
    return "a `refs/pull/` ref";
  const expression = taintedExpression(body, tainted);
  if (expression) return `the expression \`\${{${expression}}}\``;
  for (const name of [...tainted, ...IMPLICITLY_TAINTED_VARS]) {
    if (SHELL_NAME.test(name) && new RegExp(`\\$\\{?${name}\\b`).test(body))
      return `\`$${name}\`, which carries a PR-controlled value`;
  }
  return null;
}

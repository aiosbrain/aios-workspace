/** Privileged expression and acquisition policy. Unknown values fail closed. */
import { classifyValue, environmentValues, lookupEnvironment } from "./workflow-policy-values.mjs";

// Include the whole event object while excluding the fixed `github.event_name` trigger name.
export const ATTACKER_EXPR = /\bgithub\s*\.\s*(?:event\b|head_ref\b)/i;

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
  /(?:^|[\s;&|(`$/])(?:curl|wget|aria2c|http|https|scp|rsync|ftp|svn|hg|nc|gh\s+api|gh\s+release\s+download|gh\s+repo\s+clone|git\s+(?:fetch|clone|pull|archive|checkout|remote|ls-remote)|npm\s+pack|pip3?\s+download|go\s+get)\b/;
export const ARCHIVE_PRIMITIVE =
  /(?:^|[\s;&|(`/])(?:tar|bsdtar|unzip|gunzip|unxz|zstd|7z|jar|cpio)\b/;
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

export function normalizeExpression(text) {
  return String(text).replace(/\[\s*(?:'([^']*)'|"([^"]*)")\s*\]/g, (_, a, b) => `.${a ?? b}`);
}

export function untrustedResidual(text) {
  return String(text).replace(
    /github\s*\.\s*event\s*\.\s*(?:pull_request\s*\.\s*base\s*\.\s*(?:sha|ref)\b|repository\s*\.\s*default_branch\b)/gi,
    "trusted_base_ref"
  );
}

export function expressionsIn(value) {
  return [...String(value).matchAll(/\$\{\{([\s\S]*?)\}\}/g)].map((m) => m[1]);
}

export function taintedExpression(text, tainted = new Set()) {
  const resolve = (name) => lookupEnvironment(tainted.valuesByName ?? new Map(), name);
  const status = classifyValue(text, resolve);
  if (status === "safe") return null;
  return `${String(text).trim()} (${status === "tainted" ? "known PR-controlled or secret reference" : "cannot prove safe: unknown expression"})`;
}

export function taintedVarsFrom(env, inherited = new Set()) {
  const values = environmentValues(env, inherited.valuesByName);
  const out = new Set([...values].filter(([, status]) => status !== "safe").map(([key]) => key));
  out.valuesByName = values;
  return out;
}

export function prControlledRef(body, tainted) {
  if (/refs\/pull\//.test(body)) return "a `refs/pull/` ref";
  const expression = taintedExpression(body, tainted);
  if (expression) return expression;
  for (const name of [...tainted, ...IMPLICITLY_TAINTED_VARS]) {
    if (SHELL_NAME.test(name) && new RegExp(`\\$\\{?${name}\\b`).test(body))
      return `\`$${name}\`, which carries ${tainted.valuesByName?.get(name) === "tainted" ? "a PR-controlled value" : "a value we cannot prove safe"}`;
  }
  return null;
}

/**
 * sync-plan.mjs — the sync-plan safety gate: what may leave the machine, and
 * the push state that records it.
 *
 * This module IS the tier boundary (CLAUDE.md §3): `access: admin` never
 * syncs; content with missing/unresolvable `access:` frontmatter is
 * default-denied; a tier outside aios.yaml `sync_tiers` is blocked. The brain
 * independently rejects admin-tier at its own boundary with a 422
 * (docs/brain-api.md). Extracted verbatim from scripts/aios.mjs (AIO-540) so
 * the unit has a module boundary; it is the mutation target for the
 * access-governance group (scripts/run-mutation.mjs), with
 * test/sync-plan.test.mjs as the behavior oracle.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { sha256, findSecret } from "./cli-common.mjs";
import {
  parseFrontmatter,
  normalizeTier,
  classifyKind,
  redactAdminDecisionRows,
  DECISION_REDACTION_VERSION,
  parseEvidenceRows,
  evidencePayloadContent,
  validEvidenceDeclaration,
} from "./workspace-parse.mjs";
import { parseTaskRows } from "./tasks-table.mjs";

// ── file walking + classification ───────────────────────────────────────────

export function walkFiles(repo, cfg) {
  const files = [];
  const excludes = cfg.sync_exclude.map((e) => e.replace(/\/$/, ""));
  const isExcluded = (rel) => excludes.some((e) => rel === e || rel.startsWith(e + "/"));

  for (const inc of cfg.sync_include) {
    const abs = path.join(repo, inc);
    if (!existsSync(abs)) continue;
    const st = statSync(abs);
    if (st.isFile()) {
      if (!isExcluded(inc)) files.push(inc);
      continue;
    }
    const stack = [abs];
    while (stack.length) {
      const dir = stack.pop();
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const absChild = path.join(dir, entry.name);
        const rel = path.relative(repo, absChild);
        if (isExcluded(rel)) continue;
        if (entry.isDirectory()) stack.push(absChild);
        else if (entry.name.endsWith(".md") || entry.name.endsWith(".yaml")) {
          files.push(rel);
        }
      }
    }
  }
  return [...new Set(files)].sort();
}

// classifyKind + parseDecisionRows now live in ./workspace-parse.mjs (shared with the
// operator-loop collector). Imported above. parseTableRows/parseTaskRows stay in
// ./tasks-table.mjs.

// ── state ───────────────────────────────────────────────────────────────────

export function loadState(repo) {
  const p = path.join(repo, ".aios", "state.json");
  if (!existsSync(p))
    return { items: {}, last_pull: null, last_tasks_pull: null, last_decisions_pull: null };
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return { items: {}, last_pull: null, last_tasks_pull: null };
  }
}

export function saveState(repo, state) {
  const dir = path.join(repo, ".aios");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "state.json"), JSON.stringify(state, null, 2));
}

// ── plan: classify every candidate file ─────────────────────────────────────

// content_sha256 MUST describe the payload actually sent on the wire, not the raw file hash — else
// brain-api dedupe (identical sha → "unchanged", body NOT overwritten) can leave stale/leaked content
// upstream while the client marks the resync done. This matters for:
//   - decision: body+rows are redacted (H3 #380) before send — hash the REDACTED body.
//   - fact / stakeholder_mention: evidencePayloadContent() strips the raw body/source-quotes and
//     replaces them with a placeholder; the actual synced content is `rows` — hash the pushed
//     frontmatter+body+rows so the fingerprint matches the transmitted payload, not the raw file
//     (which may still contain the admin-tier transcript body/quotes that never leave the machine).
// Local change-detection (re-push decisioning) keeps the raw item.hash separately.
export function contentShaForPush(item) {
  if (item.kind !== "decision" && item.kind !== "fact" && item.kind !== "stakeholder_mention") {
    return item.hash;
  }
  return sha256(
    JSON.stringify({
      decision_redaction_version: DECISION_REDACTION_VERSION,
      access: item.tier,
      frontmatter: item.frontmatter || {},
      body: item.body,
      rows: item.rows || [],
    })
  );
}

export function buildPlan(repo, cfg, patterns, onlyPaths = null) {
  const state = loadState(repo);
  const plan = { push: [], blocked: [], clean: [] };

  let files = walkFiles(repo, cfg);
  if (onlyPaths?.length) {
    const wanted = onlyPaths.map((p) => path.relative(repo, path.resolve(repo, p)));
    files = files.filter((f) => wanted.some((w) => f === w || f.startsWith(w + "/")));
  }

  for (const rel of files) {
    const raw = readFileSync(path.join(repo, rel), "utf8");
    const { frontmatter, body } = parseFrontmatter(raw);
    const kind = classifyKind(rel, frontmatter);
    const hash = sha256(raw);
    if (!validEvidenceDeclaration(rel, frontmatter?.kind, frontmatter?.access)) {
      plan.blocked.push({
        rel,
        reason: "evidence files require their explicit kind at a canonical approved path",
      });
      continue;
    }

    const tier = normalizeTier(frontmatter?.access || "");
    if (!frontmatter || !frontmatter.access) {
      plan.blocked.push({ rel, reason: "no `access:` frontmatter (default-deny)" });
      continue;
    }
    if (tier === "admin") {
      plan.blocked.push({ rel, reason: "`access: admin` never syncs" });
      continue;
    }
    if (!cfg.sync_tiers.includes(tier)) {
      plan.blocked.push({ rel, reason: `tier '${tier}' not in sync_tiers` });
      continue;
    }
    const secret = findSecret(raw, patterns);
    if (secret) {
      plan.blocked.push({ rel, reason: `secret pattern matched: ${secret}` });
      continue;
    }

    const prev = state.items[rel];
    // A decision-log needs re-push if its redaction is stale, even when the SHA is unchanged.
    const redactionStale =
      kind === "decision" && (prev?.redaction_version || 0) < DECISION_REDACTION_VERSION;
    if (prev && prev.sha === hash && !redactionStale) {
      plan.clean.push({ rel });
      continue;
    }
    // decision → H3 (#380) redaction of BOTH body + rows (contentShaForPush hashes the
    // redacted body); fact/stakeholder_mention → strip raw body/source-quotes, push only parsed rows
    // (admin/private evidence is already blocked above by the file-tier gate + validEvidenceDeclaration).
    let rows;
    let pushFrontmatter = frontmatter;
    let pushBody = body;
    if (kind === "task") rows = parseTaskRows(body);
    else if (kind === "decision") ({ body: pushBody, rows } = redactAdminDecisionRows(body, tier));
    else if (kind === "fact" || kind === "stakeholder_mention") {
      rows = parseEvidenceRows(kind, body);
      ({ frontmatter: pushFrontmatter, body: pushBody } = evidencePayloadContent(
        kind,
        frontmatter,
        body
      ));
    }
    plan.push.push({
      rel,
      kind,
      hash,
      tier,
      frontmatter: pushFrontmatter,
      body: pushBody,
      rows,
      isNew: !prev,
    });
  }
  return { plan, state };
}

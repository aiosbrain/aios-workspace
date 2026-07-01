// C6 — Approval-gated writeback: the deterministic, side-effect-free PLANNER.
//
// C5 leaves verified artifacts on disk under `.aios/loop/closeouts/<stamp>/` (outside the synced
// spine). C6 promotes them — under explicit, per-target human approval — into the workspace spine
// (and, via the owner's own later `aios push`, onward to the brain / PM). This module decides WHAT
// to write and WHY-skip; the CLI (`scripts/aios.mjs`) performs the actual file writes. Keeping all
// tier logic here (not in the CLI) makes it unit-testable offline with no fs and no network.
//
// Tier-safety is DETERMINISTIC and derived from the verified artifact — never self-reported, never
// an LLM answer. Admin content (the owner brief, admin next-week actions) is NEVER placed in a
// syncable location. The independent leak re-sweep is belt-and-suspenders over C5's own sweep, run
// on the exact bytes about to hit a syncable path; it FAILS CLOSED when its manifest is unavailable.

import path from "node:path";
import { createHash } from "node:crypto";
import type { Tier } from "./signal.js";
import { resolveTier } from "./signal.js";
import type { Audience } from "./ledger.js";
import { visibleTiers } from "./ledger.js";
import type { NextWeekAction } from "./drafter.js";
import type { RunManifest } from "./manifest.js";
import type { VerifierStatus } from "./verifier.js";
import { aboveAudienceStrings } from "./project.js";
import { sweepForLeaks } from "./leak-sweep.js";

/** The three independently-approvable writeback targets (spec: c6-writeback.md). */
export type WritebackTarget = "local" | "sync" | "pm";

/** A shareable audience — the two tiers C5 can render a digest for. */
export type ShareAudience = "team" | "external";

/**
 * Why a candidate write was withheld. Every value is a fixed enum — a `Skip` is audience-safe BY
 * CONSTRUCTION (see {@link Skip}) precisely because it never carries free text derived from content.
 */
export type SkipCode =
  | "not-shippable" // digest-<aud>.FAILED.md present — C5 marked it non-shippable
  | "missing-digest" // no shippable digest body and no FAILED marker (e.g. fully leak-withheld)
  | "verifier-unavailable" // verifier-<aud>.json absent or unparsable
  | "verifier-failed" // verifier status not pass|corrected
  | "admin-tier" // an admin next-week action — never becomes a synced task row
  | "above-ceiling" // action tier exceeds the tasks.md file tier (the ceiling)
  | "missing-tasks" // no tasks.md to write rows into
  | "missing-folder" // the destination spine folder does not exist
  | "no-manifest" // leak backstop unavailable → syncable write withheld (fail-closed)
  | "leak-detected"; // independent re-sweep hit an above-audience string → withheld

/**
 * A withheld candidate. AUDIENCE-SAFE BY CONSTRUCTION: only enum code, target, artifact kind,
 * audience, and a count — NEVER a raw action title, path, row text, or the offending leak string.
 * This is what lets `--json` and the printed plan serialize skips without a leak surface.
 */
export interface Skip {
  code: SkipCode;
  target: WritebackTarget | "all";
  artifact: "brief" | "digest" | "tasks";
  audience?: ShareAudience;
  /** Number of items collapsed under this code (e.g. how many admin actions were dropped). */
  count?: number;
}

/** A tasks-table row — the SIX core fields only. Emitting hierarchy fields (parent/labels/priority)
 *  would trip `mergeTaskWriteback`'s widening and restructure the user's table, so we never do. */
export interface TaskRow {
  row_key: string;
  title: string;
  assignee: string;
  status: string;
  sprint: string;
  due: string | null;
}

/** A planned file write. `destPath` (absolute) is for the executor; `destRel` (repo-relative) is the
 *  ONLY path form shown to the user / serialized to `--json`. */
export interface FileWrite {
  id: string; // "brief" | "digest-team" | "digest-external"
  artifact: "brief" | "digest";
  audience?: ShareAudience;
  tier: Tier; // access tier stamped into the file
  destPath: string; // absolute — internal to execution
  destRel: string; // repo-relative — display + JSON
  content: string; // final, frontmatter-stamped
  syncable: boolean; // false for the admin brief; true for tier-safe digests
  targets: WritebackTarget[]; // which approved flags cause this file to be written
}

/** The planned tasks.md merge (tier-safe rows only). `null` when there are no rows / no tasks.md. */
export interface TaskWrite {
  tasksPath: string; // absolute
  tasksRel: string; // repo-relative
  rows: TaskRow[];
  targets: WritebackTarget[]; // always ["sync","pm"]
}

export interface WritebackPlan {
  stamp: string;
  fileWrites: FileWrite[];
  taskWrite: TaskWrite | null;
  skips: Skip[];
  /** True if any syncable entry was withheld for a tier-safety reason (no-manifest / leak-detected).
   *  The CLI turns this (scoped to approved targets) into a non-zero exit — fail-closed. */
  tierSafetyWithheld: boolean;
}

/** One shareable audience's on-disk state, assembled by the CLI from the closeout dir. */
export interface ShareableOnDisk {
  audience: ShareAudience;
  shippable: boolean; // digest-<aud>.md exists
  hasFailedMarker: boolean; // digest-<aud>.FAILED.md exists
  digestMarkdown: string | null; // body of digest-<aud>.md; null when non-shippable/absent
  verifierStatus: VerifierStatus | null; // null = verifier-<aud>.json absent or unparsable
}

export interface PlanWritebackInput {
  stamp: string;
  member: string; // task-row assignee
  repoRel: (abs: string) => string; // repo-relative projector (CLI passes path.relative(repo, .))
  briefMarkdown: string; // body of brief.md (already access:admin-stamped by C5)
  ownerNextWeekActions: NextWeekAction[]; // from next-week-actions.json (INCLUDES admin)
  shareables: ShareableOnDisk[];
  spinePaths: { work: string | null; log: string | null; shared: string | null }; // absolute
  tasksPath: string | null; // absolute; null when tasks.md does not exist
  tasksFileTier: Tier; // ceiling read from tasks.md frontmatter (validated)
  manifest: RunManifest | null; // leak backstop; null → syncable targets fail closed
}

// ── Pure helpers (exported for direct unit testing) ─────────────────────────────────────────────

/** `visibleTiers` takes an `Audience`, not a `Tier` — this is the only correct conversion. Handing a
 *  raw `Tier` to `visibleTiers` would let "admin" resolve to the owner-visible set. */
export function audienceForTier(tier: Tier): Audience {
  if (tier === "admin") return "owner";
  return tier; // "team" -> "team", "external" -> "external"
}

/** Canonical tier resolution with a safe default. Reuses `resolveTier` (which returns `null` for
 *  unknown/multi-valued/malformed input) and defaults to the least-privileged syncable tier. */
export function resolveTierOrDefault(raw: string | string[] | null | undefined): Tier {
  return resolveTier(raw) ?? "team";
}

/** Stamp `access: <tier>` frontmatter, ENFORCING the tier: any existing leading frontmatter block is
 *  stripped and replaced. This both avoids a double `---` block AND guarantees the written file's
 *  effective `access` is exactly the tier C6 chose — a stale or hand-edited `access:` on a closeout
 *  artifact can never mis-tier a promoted digest. Mirrors `parseFrontmatter`'s block detection. */
export function stampFrontmatter(markdown: string, tier: Tier): string {
  let body = markdown;
  if (markdown.startsWith("---")) {
    const end = markdown.indexOf("\n---", 3);
    if (end !== -1) {
      const nl = markdown.indexOf("\n", end + 1);
      body = nl === -1 ? "" : markdown.slice(nl + 1);
    }
  }
  return `---\naccess: ${tier}\n---\n\n${body.replace(/^\n+/, "")}`;
}

/** Stable, title-derived key so re-running the same closeout never duplicates a row and a recurring
 *  weekly title merges in place. The `nw-` prefix namespaces loop rows away from human/brain keys. */
export function deriveRowKey(title: string): string {
  const norm = title.trim().toLowerCase().replace(/\s+/g, " ");
  return "nw-" + createHash("sha256").update(norm).digest("hex").slice(0, 8);
}

/** Map a tier-safe next-week action to a 6-field task row (never widens the table). */
export function actionToRow(action: NextWeekAction, member: string): TaskRow {
  return {
    row_key: deriveRowKey(action.title),
    title: action.title,
    assignee: member,
    status: "todo",
    sprint: "",
    due: null,
  };
}

/** Whether a shareable digest may be promoted, and if not, the specific safe reason. File presence is
 *  primary (a digest body must exist); verifier status only corroborates. */
export function promotability(s: ShareableOnDisk): { ok: true } | { ok: false; code: SkipCode } {
  // A FAILED marker is authoritative: never promote, even if a stale shippable digest coexists.
  if (s.hasFailedMarker) return { ok: false, code: "not-shippable" };
  if (!s.shippable || s.digestMarkdown == null) return { ok: false, code: "missing-digest" };
  if (s.verifierStatus == null) return { ok: false, code: "verifier-unavailable" };
  if (s.verifierStatus !== "pass" && s.verifierStatus !== "corrected") {
    return { ok: false, code: "verifier-failed" };
  }
  return { ok: true };
}

// ── The planner ─────────────────────────────────────────────────────────────────────────────────

const DIGEST_TIER: Record<ShareAudience, Tier> = { team: "team", external: "external" };

export function planWriteback(input: PlanWritebackInput): WritebackPlan {
  const {
    stamp,
    member,
    repoRel,
    briefMarkdown,
    ownerNextWeekActions,
    shareables,
    spinePaths,
    tasksPath,
    tasksFileTier,
    manifest,
  } = input;

  const fileWrites: FileWrite[] = [];
  const skips: Skip[] = [];
  let tierSafetyWithheld = false;

  // ── Owner brief: admin-tier, local-only, NEVER syncable → no leak sweep, no manifest needed. ──
  if (spinePaths.log) {
    const destPath = path.join(spinePaths.log, `loop-brief-${stamp}.md`);
    fileWrites.push({
      id: "brief",
      artifact: "brief",
      tier: "admin",
      destPath,
      destRel: repoRel(destPath),
      content: stampFrontmatter(briefMarkdown, "admin"),
      syncable: false,
      targets: ["local"],
    });
  } else {
    skips.push({ code: "missing-folder", target: "local", artifact: "brief" });
  }

  // ── Shareable digests: syncable → require a leak-clean pass against the closeout manifest. ──
  const digestDir: Record<ShareAudience, string | null> = {
    team: spinePaths.work,
    external: spinePaths.shared,
  };
  for (const s of shareables) {
    const prom = promotability(s);
    if (!prom.ok) {
      skips.push({ code: prom.code, target: "all", artifact: "digest", audience: s.audience });
      continue;
    }
    const dir = digestDir[s.audience];
    if (!dir) {
      skips.push({
        code: "missing-folder",
        target: "all",
        artifact: "digest",
        audience: s.audience,
      });
      continue;
    }
    const tier = DIGEST_TIER[s.audience];
    const content = stampFrontmatter(s.digestMarkdown as string, tier);
    // Syncable content requires the fail-closed leak backstop.
    if (!manifest) {
      skips.push({ code: "no-manifest", target: "all", artifact: "digest", audience: s.audience });
      tierSafetyWithheld = true;
      continue;
    }
    const hits = sweepForLeaks(content, aboveAudienceStrings(manifest, audienceForTier(tier)));
    if (hits.length) {
      skips.push({
        code: "leak-detected",
        target: "all",
        artifact: "digest",
        audience: s.audience,
      });
      tierSafetyWithheld = true;
      continue;
    }
    const destPath = path.join(dir, `weekly-digest-${s.audience}-${stamp}.md`);
    fileWrites.push({
      id: `digest-${s.audience}`,
      artifact: "digest",
      audience: s.audience,
      tier,
      destPath,
      destRel: repoRel(destPath),
      content,
      syncable: true,
      targets: ["local", "sync"],
    });
  }

  // ── Next-week actions → tasks.md rows: tier-safe ONLY (admin always excluded), leak-swept. ──
  let taskWrite: TaskWrite | null = null;
  if (!tasksPath) {
    skips.push({ code: "missing-tasks", target: "all", artifact: "tasks" });
  } else {
    // Admissible = tiers visible at the file's ceiling, with admin explicitly removed. The delete is
    // belt-and-suspenders: even if the ceiling ever resolved to an admin-including set, admin actions
    // can never become a synced row.
    const admissible = new Set(visibleTiers(audienceForTier(tasksFileTier)));
    admissible.delete("admin");

    const above = manifest ? aboveAudienceStrings(manifest, audienceForTier(tasksFileTier)) : null;
    const rows: TaskRow[] = [];
    let adminCount = 0;
    let ceilingCount = 0;
    let noManifestCount = 0;
    let leakCount = 0;

    for (const a of ownerNextWeekActions) {
      if (a.tier === "admin") {
        adminCount++;
        continue;
      }
      if (!admissible.has(a.tier)) {
        ceilingCount++;
        continue;
      }
      if (!above) {
        noManifestCount++;
        tierSafetyWithheld = true;
        continue;
      }
      // Sweep the EXACT serialized row (all six fields), not just the title, so nothing that lands in
      // the synced tasks.md line escapes the backstop.
      const row = actionToRow(a, member);
      const rowText = [
        row.row_key,
        row.title,
        row.assignee,
        row.status,
        row.sprint,
        row.due ?? "",
      ].join(" ");
      if (sweepForLeaks(rowText, above).length) {
        leakCount++;
        tierSafetyWithheld = true;
        continue;
      }
      rows.push(row);
    }

    if (adminCount)
      skips.push({ code: "admin-tier", target: "all", artifact: "tasks", count: adminCount });
    if (ceilingCount)
      skips.push({ code: "above-ceiling", target: "all", artifact: "tasks", count: ceilingCount });
    if (noManifestCount)
      skips.push({ code: "no-manifest", target: "all", artifact: "tasks", count: noManifestCount });
    if (leakCount)
      skips.push({ code: "leak-detected", target: "all", artifact: "tasks", count: leakCount });

    if (rows.length) {
      taskWrite = { tasksPath, tasksRel: repoRel(tasksPath), rows, targets: ["sync", "pm"] };
    }
  }

  return { stamp, fileWrites, taskWrite, skips, tierSafetyWithheld };
}

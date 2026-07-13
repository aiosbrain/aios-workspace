// Deliverables source — one signal per markdown file under the work dir (2-work / legacy
// 02-deliverables). Tier is the file's `access:` frontmatter; files with no resolvable tier
// are excluded (default-deny). occurredAt is the file mtime; summary is the first H1 or the
// basename.

import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { parseFrontmatter } from "../parsers.js";
import { resolveTier } from "../signal.js";
import type { Source, SourceResult } from "./types.js";

const IGNORED_DIRS = new Set([
  ".git",
  ".venv",
  "venv",
  "node_modules",
  "site-packages",
  "__pycache__",
  ".pytest_cache",
]);

function walkMarkdown(root: string, dir: string): string[] {
  const out: string[] = [];
  const abs = path.join(root, dir);
  if (!existsSync(abs)) return out;
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory() && !IGNORED_DIRS.has(entry.name)) out.push(...walkMarkdown(root, rel));
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(rel);
  }
  return out;
}

function firstHeading(body: string): string | null {
  for (const line of body.split("\n")) {
    const m = line.match(/^#\s+(.+)$/);
    if (m && m[1]) return m[1].trim();
  }
  return null;
}

export const deliverablesSource: Source = (ctx): SourceResult => {
  const out: SourceResult = { signals: [], excluded: [] };
  if (!ctx.spine.work) return out;

  for (const rel of walkMarkdown(ctx.root, ctx.spine.work)) {
    const abs = path.join(ctx.root, rel);
    const raw = readFileSync(abs, "utf8");
    const { frontmatter, body } = parseFrontmatter(raw);
    const tier = resolveTier(frontmatter?.access ?? null);
    if (!tier) {
      out.excluded.push({
        ref: rel,
        reason: "deliverable has no resolvable access tier (default-deny)",
      });
      continue;
    }
    const base = rel.split("/").pop() ?? rel;
    out.signals.push({
      kind: "deliverable",
      source: "deliverable",
      tier,
      occurredAt: statSync(abs).mtime.toISOString(),
      ref: { path: rel, tier },
      summary: firstHeading(body) ?? base,
      payload: {
        status: frontmatter?.status ?? null,
        owner: frontmatter?.owner ?? null,
        // Body content hash so the C4 change-tracker detects body-only edits (not just H1/
        // status/owner changes). Granularity is source-controlled by design (see changes.ts).
        contentHash: createHash("sha256").update(body).digest("hex"),
      },
    });
  }
  return out;
};

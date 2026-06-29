// Inbox source — summaries + from-brain pulls under the inbox dir (1-inbox / legacy
// 01-intake). Inbox content is admin-tier by spine default but individual files may lack
// an `access:` tag; those are excluded (default-deny) and logged — the canonical example of
// the exclusion path. Transcripts are skipped here (they feed decisions via a harness, not
// the loop directly).

import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "../parsers.js";
import { resolveTier } from "../signal.js";
import type { Source, SourceResult } from "./types.js";

function walkMarkdown(root: string, dir: string): string[] {
  const out: string[] = [];
  const abs = path.join(root, dir);
  if (!existsSync(abs)) return out;
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walkMarkdown(root, rel));
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(rel);
  }
  return out;
}

export const inboxSource: Source = (ctx): SourceResult => {
  const out: SourceResult = { signals: [], excluded: [] };
  if (!ctx.spine.inbox) return out;

  for (const rel of walkMarkdown(ctx.root, ctx.spine.inbox)) {
    if (rel.includes("/transcripts/")) continue;
    const abs = path.join(ctx.root, rel);
    const raw = readFileSync(abs, "utf8");
    const { frontmatter, body } = parseFrontmatter(raw);
    const tier = resolveTier(frontmatter?.access ?? null);
    if (!tier) {
      out.excluded.push({ ref: rel, reason: "inbox item has no resolvable access tier (default-deny)" });
      continue;
    }
    const base = rel.split("/").pop() ?? rel;
    const firstLine = body.split("\n").find((l) => l.trim().length > 0) ?? base;
    out.signals.push({
      kind: "inbox",
      source: "inbox",
      tier,
      occurredAt: statSync(abs).mtime.toISOString(),
      ref: { path: rel, tier },
      summary: firstLine.replace(/^#+\s*/, "").slice(0, 200),
      payload: { from_brain: rel.includes("from-brain/") },
    });
  }
  return out;
};

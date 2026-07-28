// Inbox source — summaries + from-brain pulls under the inbox dir (1-inbox / legacy
// 01-intake). Inbox content is admin-tier by spine default but individual files may lack
// an `access:` tag; those are excluded (default-deny) and logged — the canonical example of
// the exclusion path. Transcripts are skipped here (they feed decisions via a harness, not
// the loop directly).

import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import path from "node:path";
import { parseFrontmatter, classifyKind } from "../parsers.js";
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
    const abs = path.join(ctx.root, rel);
    const raw = readFileSync(abs, "utf8");
    const { frontmatter, body } = parseFrontmatter(raw);
    // Transcripts feed decisions via a harness, not the loop directly. Skip by KIND (frontmatter
    // type === "transcript" OR a /transcripts/ path), not a path substring alone — a transcript
    // pulled from the brain may land elsewhere in 1-inbox.
    if (classifyKind(rel, frontmatter) === "transcript") continue;
    const tier = resolveTier(frontmatter?.access ?? null);
    if (!tier) {
      out.excluded.push({
        ref: rel,
        reason: "inbox item has no resolvable access tier (default-deny)",
      });
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
      // `origin_project` is written by `aios pull` and names the brain project a file came
      // from. It rides along so downstream consumers can tell a hand-written inbox note from a
      // machine-generated mirror feed (the commits project) without parsing the flattened
      // filename — see the commit-mirror fold in closeout.ts.
      payload: {
        from_brain: rel.includes("from-brain/"),
        ...(typeof frontmatter?.origin_project === "string"
          ? { origin_project: frontmatter.origin_project }
          : {}),
      },
    });
  }
  return out;
};

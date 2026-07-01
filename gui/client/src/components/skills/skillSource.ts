import type { SkillEntry } from "../../types/protocol";

/**
 * Build a GitHub "view source" URL for a skill so the user can inspect the repo
 * BEFORE installing. Marketplace skills carry a precise `source.path_in_repo`;
 * official skills only carry repo + pinned commit, so we link to the repo at that
 * commit (best-effort, always resolves). Returns null when the source is unknown
 * (e.g. community demo skills) so the link is omitted gracefully.
 */
function githubUrl(repo?: string, commit?: string, sub?: string): string | null {
  if (!repo) return null;
  const base = repo.replace(/\.git$/, "").replace(/\/+$/, "");
  if (!/^https?:\/\/github\.com\//i.test(base)) return null;
  const ref = commit ? `/tree/${commit}` : "";
  const path = sub ? `/${sub.replace(/^\/+/, "")}` : "";
  return `${base}${ref}${path}`;
}

export function skillSourceUrl(s: Pick<SkillEntry, "source" | "provenance">): string | null {
  if (s.source?.repo) return githubUrl(s.source.repo, s.source.commit, s.source.path_in_repo);
  if (s.provenance?.upstream_repo)
    return githubUrl(s.provenance.upstream_repo, s.provenance.upstream_commit);
  return null;
}

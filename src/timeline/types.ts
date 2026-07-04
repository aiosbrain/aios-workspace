// Timeline (AIO-203) — cross-repo "what we shipped" data model.
//
// Reuses the operator-loop's canonical Tier vocabulary and can project items into the
// C1 Signal shape, but is deliberately NOT part of the V1 Operator Loop project scope:
// docs/v1-operator-loop/README.md scopes cross-person/team aggregation to M2, and the
// inert sources/github.ts stub stays solo-loop-scoped. This module is the sibling
// multi-repo capability.

import type { Signal, Tier } from "../operator-loop/signal.js";

/** Who a render is for. There is no "admin" render — admin-tier repos never render. */
export type Audience = "team" | "external";

export interface TimelineRepoConfig {
  /** Absolute path to the repo checkout. */
  path: string;
  /** Display name in renders (defaults to the path basename). */
  alias: string;
  /** Repo-level tier; every PR/commit from the repo inherits it. Default-deny: admin never renders. */
  tier: Tier;
  /** Production URL used as the screenshot fallback when no PR preview URL is found. */
  liveUrl?: string;
}

export interface TimelinePr {
  repo: string; // repo alias
  tier: Tier;
  number: number;
  title: string;
  author: string | null; // GitHub login
  mergedAt: string; // ISO
  url: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
}

export interface TimelineCommit {
  repo: string; // repo alias
  tier: Tier;
  sha: string;
  authorName: string;
  authorEmail: string;
  /** GitHub login derived from a users.noreply.github.com address, when possible. */
  authorLogin: string | null;
  authoredAt: string; // ISO
  subject: string;
}

export interface TimelineRepoResult {
  repo: TimelineRepoConfig;
  prs: TimelinePr[];
  commits: TimelineCommit[];
  /** Non-null → `gh` was unavailable/failed and the repo degraded to commit-only data. */
  ghError: string | null;
}

export interface TimelineData {
  generatedAt: string;
  since: string; // ISO
  until: string; // ISO
  repos: TimelineRepoResult[];
}

/** Project a merged PR into the C1 signal shape so downstream tooling can share logic. */
export function prToSignal(pr: TimelinePr): Signal {
  return {
    kind: "merged-pr",
    source: "timeline",
    tier: pr.tier,
    occurredAt: pr.mergedAt,
    ref: { path: `${pr.repo}#${pr.number}`, tier: pr.tier },
    summary: pr.title,
    payload: { url: pr.url, author: pr.author, repo: pr.repo },
  };
}

/** Project a raw commit into the C1 signal shape. */
export function commitToSignal(commit: TimelineCommit): Signal {
  return {
    kind: "commit",
    source: "timeline",
    tier: commit.tier,
    occurredAt: commit.authoredAt,
    ref: { path: `${commit.repo}@${commit.sha.slice(0, 12)}`, tier: commit.tier },
    summary: commit.subject,
    payload: { author: commit.authorLogin ?? commit.authorName, repo: commit.repo },
  };
}

export function toSignals(data: TimelineData): Signal[] {
  const signals: Signal[] = [];
  for (const r of data.repos) {
    for (const pr of r.prs) signals.push(prToSignal(pr));
    for (const commit of r.commits) signals.push(commitToSignal(commit));
  }
  return signals;
}

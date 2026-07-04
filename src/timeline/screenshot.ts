// Screenshot capture pipeline (AIO-207).
//
// Target resolution per merged PR: Vercel preview URL from the Vercel bot's PR comment →
// the repo's configured production `liveUrl` → no visual target (a "code change" card).
// Capture drives the same pinned `agent-browser` CLI the nightly UX harness uses
// (test/ux/driver.mjs): open → wait --load networkidle → screenshot. Every failure path
// (missing binary, timeout, 4xx page) degrades to the code-change card — a screenshot
// problem must never fail the timeline run.

import type { Runner } from "./collect.js";
import type { TimelinePr, TimelineRepoConfig } from "./types.js";

export interface ShotTarget {
  kind: "preview" | "live" | "card";
  url: string | null; // null ⇔ kind === "card"
}

// Vercel preview deploys live on *.vercel.app; the bot comment wraps the URL in a
// markdown table ("Visit Preview"). Match conservatively, strip trailing punctuation.
const VERCEL_URL_RE = /https:\/\/[a-z0-9][a-z0-9.-]*\.vercel\.app[^\s)\]"'<>|]*/i;

/** Extract a Vercel preview URL from a GitHub issue-comments JSON payload, else null. */
export function extractPreviewUrl(commentsJson: string): string | null {
  let rows: unknown;
  try {
    rows = JSON.parse(commentsJson);
  } catch {
    return null;
  }
  if (!Array.isArray(rows)) return null;
  // Prefer comments authored by the Vercel bot; fall back to any comment carrying a
  // vercel.app URL (self-hosted bots, renamed apps).
  const bodies: string[] = [];
  for (const row of rows as { body?: unknown; user?: { login?: unknown } }[]) {
    if (typeof row?.body !== "string") continue;
    const login = typeof row.user?.login === "string" ? row.user.login.toLowerCase() : "";
    if (login.startsWith("vercel")) bodies.unshift(row.body);
    else bodies.push(row.body);
  }
  for (const body of bodies) {
    const m = VERCEL_URL_RE.exec(body);
    if (m) return m[0];
  }
  return null;
}

/**
 * Resolve what to screenshot for one PR. `gh api` uses the repo cwd's `{owner}/{repo}`
 * placeholder resolution, so no slug parsing is needed. Any `gh` failure falls through
 * to the live-URL / card fallbacks.
 */
export function resolveShotTarget(
  pr: TimelinePr,
  repo: TimelineRepoConfig,
  runner: Runner
): ShotTarget {
  try {
    const out = runner(
      "gh",
      ["api", `repos/{owner}/{repo}/issues/${pr.number}/comments`, "--paginate"],
      { cwd: repo.path, timeoutMs: 15_000 }
    );
    const preview = extractPreviewUrl(out);
    if (preview) return { kind: "preview", url: preview };
  } catch {
    // fall through to live/card
  }
  if (repo.liveUrl) return { kind: "live", url: repo.liveUrl };
  return { kind: "card", url: null };
}

export interface CaptureResult {
  ok: boolean;
  path: string | null;
  error: string | null;
}

/**
 * Capture one URL to a PNG via agent-browser (same invocation vocabulary as the UX harness).
 * A shared session name keeps one browser alive across a batch; call `closeShotSession`
 * when the batch is done. Every step carries a hard timeout — an auth-walled or never-idle
 * page must cost seconds, not minutes (a screenshot of a gated preview once hung >5 min).
 */
export function captureShot(
  url: string,
  outPath: string,
  runner: Runner,
  session = "aios-timeline"
): CaptureResult {
  try {
    runner("agent-browser", ["--session", session, "open", url], { timeoutMs: 30_000 });
    try {
      runner("agent-browser", ["--session", session, "wait", "--load", "networkidle"], {
        timeoutMs: 20_000,
      });
    } catch {
      // slow third-party beacons keep networkidle from settling; screenshot anyway
    }
    runner("agent-browser", ["--session", session, "screenshot", outPath], { timeoutMs: 30_000 });
    return { ok: true, path: outPath, error: null };
  } catch (e) {
    return {
      ok: false,
      path: null,
      error: (e as Error).message?.split("\n")[0] ?? "capture failed",
    };
  }
}

/** Best-effort session teardown; never throws. */
export function closeShotSession(runner: Runner, session = "aios-timeline"): void {
  try {
    runner("agent-browser", ["--session", session, "close"], { timeoutMs: 10_000 });
  } catch {
    // already gone
  }
}

// Contributor avatar resolution (AIO-206).
//
// Order: brain roster (`GET /api/v1/members` → `github_login`/`avatar_url`, matched by login
// or email) → GitHub's public avatar CDN (`https://github.com/<login>.png`, no token/PII) →
// null (the renderer draws an initials fallback). Any brain failure degrades silently to the
// CDN path — avatar resolution must never fail a timeline run.

export interface BrainMember {
  github_login: string | null;
  avatar_url: string | null;
  email?: string | null;
  display_name?: string | null;
}

export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> }
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface BrainOpts {
  brainUrl?: string | null;
  apiKey?: string | null;
  team?: string | null;
  fetchImpl?: FetchLike;
}

/** Fetch the brain roster; ANY failure (no config, network, non-200) returns []. */
export async function fetchBrainMembers(opts: BrainOpts): Promise<BrainMember[]> {
  const { brainUrl, apiKey, team } = opts;
  if (!brainUrl || !apiKey) return [];
  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  try {
    const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
    if (team) headers["X-AIOS-Team"] = team;
    const res = await fetchImpl(`${brainUrl.replace(/\/$/, "")}/api/v1/members`, { headers });
    if (!res.ok) return [];
    const body = (await res.json()) as { members?: unknown };
    if (!Array.isArray(body.members)) return [];
    return body.members.filter((m): m is BrainMember => !!m && typeof m === "object");
  } catch {
    return [];
  }
}

export interface AvatarSubject {
  login?: string | null;
  email?: string | null;
}

/**
 * Resolve one contributor to an avatar URL, or null when nothing is resolvable
 * (the renderer then falls back to an inline initials mark).
 */
export function resolveAvatarUrl(subject: AvatarSubject, members: BrainMember[]): string | null {
  const login = subject.login?.toLowerCase() ?? null;
  const email = subject.email?.toLowerCase() ?? null;
  for (const m of members) {
    const mLogin = m.github_login?.toLowerCase() ?? null;
    const mEmail = m.email?.toLowerCase() ?? null;
    if ((login && mLogin === login) || (email && mEmail === email)) {
      if (m.avatar_url) return m.avatar_url;
      break; // known member without a synced avatar → CDN fallback below
    }
  }
  if (subject.login) return `https://github.com/${subject.login}.png`;
  return null;
}

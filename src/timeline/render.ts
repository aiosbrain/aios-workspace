// Dual-audience HTML renderer (AIO-208).
//
// One collected dataset, two render passes:
//   team     — full detail: every repo with tier ≤ team (team + external), PR links, gh notes.
//   external — strictly a subset: ONLY external-tier repos, no links back into private repos,
//              no gh diagnostics. The CLI additionally sweeps this output with leak-gate.sh
//              (fail-closed) before it is considered shareable.
// Admin-tier repos render NOWHERE — the timeline is a sharing artifact, never an admin surface.
//
// Styling consumes @aios-alpha/design tokens (tokens.css inlined verbatim — the caller loads it
// from the installed package; token VALUES are never vendored here). Editorial Minimal, light is
// the :root default and `.dark` switches mode; output is a single self-contained file (images
// and avatars arrive as data: URIs via RenderAssets).

import type { Audience, TimelineData, TimelinePr } from "./types.js";

export interface RenderAssets {
  /** Verbatim contents of @aios-alpha/design/tokens.css. */
  tokensCss: string;
  /** Avatar image source per contributor key (see contributorKey) — data: URI or https URL. */
  avatars: Map<string, string>;
  /** Screenshot source per PR key `${repo}#${number}` — data: URI or file path. */
  shots: Map<string, string>;
}

export function contributorKey(subject: {
  login?: string | null;
  email?: string | null;
  name?: string | null;
}): string {
  if (subject.login) return `login:${subject.login.toLowerCase()}`;
  if (subject.email) return `email:${subject.email.toLowerCase()}`;
  return `name:${(subject.name ?? "unknown").toLowerCase()}`;
}

export function prKey(pr: Pick<TimelinePr, "repo" | "number">): string {
  return `${pr.repo}#${pr.number}`;
}

/** Audience gate. team sees {team, external}; external sees only {external}; admin sees no render. */
export function tiersForAudience(audience: Audience): ReadonlySet<string> {
  return audience === "team" ? new Set(["team", "external"]) : new Set(["external"]);
}

/** Filter a dataset down to what an audience may see. External ⊂ team by construction. */
export function filterForAudience(data: TimelineData, audience: Audience): TimelineData {
  const allowed = tiersForAudience(audience);
  return {
    ...data,
    repos: data.repos
      .filter((r) => allowed.has(r.repo.tier))
      .map((r) => ({
        ...r,
        prs: r.prs.filter((p) => allowed.has(p.tier)),
        commits: r.commits.filter((commitRow) => allowed.has(commitRow.tier)),
        // gh diagnostics are operator detail — never shown outside the team render
        ghError: audience === "team" ? r.ghError : null,
      })),
  };
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Deterministic inline initials mark for contributors with no resolvable avatar. */
export function initialsAvatarDataUri(nameOrLogin: string): string {
  const initials = (nameOrLogin.trim() || "?")
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => (w[0] ?? "?").toUpperCase())
    .join("");
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">` +
    `<rect width="64" height="64" rx="32" fill="#57534e"/>` +
    `<text x="32" y="41" font-family="Georgia,serif" font-size="26" fill="#fafaf8" text-anchor="middle">${escapeHtml(initials)}</text>` +
    `</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

function fmtDay(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t).toISOString().slice(0, 10);
}

function diffStat(pr: TimelinePr): string {
  const parts: string[] = [];
  if (typeof pr.changedFiles === "number")
    parts.push(`${pr.changedFiles} file${pr.changedFiles === 1 ? "" : "s"}`);
  if (typeof pr.additions === "number") parts.push(`+${pr.additions}`);
  if (typeof pr.deletions === "number") parts.push(`−${pr.deletions}`);
  return parts.join(" · ");
}

const PAGE_CSS = `
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--aios-bg); color: var(--aios-fg);
    font-family: var(--aios-font-body); font-size: var(--aios-text-body);
    line-height: var(--aios-leading-normal);
  }
  .wrap { max-width: var(--aios-layout-max-width); margin: 0 auto; padding: var(--aios-space-10) var(--aios-layout-gutter) var(--aios-space-20); }
  header.masthead { display: flex; align-items: baseline; justify-content: space-between; gap: var(--aios-space-4);
    border-bottom: 1px solid var(--aios-border-visible); padding-bottom: var(--aios-space-6); margin-bottom: var(--aios-space-10); }
  h1 { font-family: var(--aios-font-display); font-weight: var(--aios-weight-regular);
    font-size: var(--aios-text-h1); letter-spacing: var(--aios-tracking-tight); line-height: var(--aios-leading-tight); margin: 0; }
  .range { color: var(--aios-fg-secondary); font-size: var(--aios-text-small); white-space: nowrap; }
  .badge { display: inline-block; border: 1px solid var(--aios-border-strong); border-radius: var(--aios-radius-full);
    padding: 2px 12px; font-size: var(--aios-text-label); letter-spacing: var(--aios-tracking-wide);
    text-transform: uppercase; color: var(--aios-fg-secondary); }
  .theme-toggle { border: 1px solid var(--aios-border-strong); background: var(--aios-primary); color: var(--aios-primary-fg);
    border-radius: var(--aios-radius-full); padding: 6px 16px; font-family: var(--aios-font-body);
    font-size: var(--aios-text-label); cursor: pointer; }
  section.repo { margin-bottom: var(--aios-space-16); }
  h2 { font-family: var(--aios-font-display); font-weight: var(--aios-weight-regular);
    font-size: var(--aios-text-h3); margin: 0 0 var(--aios-space-2); }
  .repo-meta { color: var(--aios-fg-muted); font-size: var(--aios-text-small); margin-bottom: var(--aios-space-6); }
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: var(--aios-space-6); }
  .card { background: var(--aios-surface); border: 1px solid var(--aios-border); border-radius: var(--aios-radius-lg);
    box-shadow: var(--aios-shadow-card); overflow: hidden; display: flex; flex-direction: column; }
  .card img.shot { width: 100%; aspect-ratio: 16/10; object-fit: cover; object-position: top;
    border-bottom: 1px solid var(--aios-border); display: block; }
  .code-card { aspect-ratio: 16/10; display: flex; flex-direction: column; justify-content: center; align-items: center;
    gap: var(--aios-space-2); background: var(--aios-code-bg); border-bottom: 1px solid var(--aios-border);
    font-family: var(--aios-font-mono); font-size: var(--aios-text-small); color: var(--aios-fg-secondary); }
  .code-card .stat { font-size: var(--aios-text-body-lg); color: var(--aios-fg); }
  .card-body { padding: var(--aios-space-5); display: flex; flex-direction: column; gap: var(--aios-space-3); flex: 1; }
  .card-title { font-weight: var(--aios-weight-semibold); font-size: var(--aios-text-body); line-height: var(--aios-leading-snug); }
  .card-title a { color: inherit; text-decoration: none; border-bottom: 1px solid var(--aios-border-strong); }
  .byline { display: flex; align-items: center; gap: var(--aios-space-2); margin-top: auto;
    color: var(--aios-fg-secondary); font-size: var(--aios-text-small); }
  .byline img { width: 24px; height: 24px; border-radius: var(--aios-radius-full); border: 1px solid var(--aios-border); }
  .byline .date { margin-left: auto; color: var(--aios-fg-muted); }
  ul.commits { list-style: none; padding: 0; margin: var(--aios-space-6) 0 0; border-top: 1px solid var(--aios-border);
    font-size: var(--aios-text-small); }
  ul.commits li { display: flex; gap: var(--aios-space-3); padding: var(--aios-space-2) 0;
    border-bottom: 1px solid var(--aios-border); }
  ul.commits .sha { font-family: var(--aios-font-mono); color: var(--aios-fg-muted); }
  ul.commits .who { margin-left: auto; color: var(--aios-fg-muted); white-space: nowrap; }
  .gh-note { color: var(--aios-amber); font-size: var(--aios-text-label); margin-top: var(--aios-space-2); }
  .empty { color: var(--aios-fg-muted); font-style: italic; }
  footer { border-top: 1px solid var(--aios-border-visible); margin-top: var(--aios-space-16);
    padding-top: var(--aios-space-4); color: var(--aios-fg-muted); font-size: var(--aios-text-label); }
`;

const THEME_SCRIPT = `
  (function () {
    var saved = null;
    try { saved = localStorage.getItem("aios-timeline-theme"); } catch (e) { /* file:// */ }
    var dark = saved ? saved === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
    if (dark) document.documentElement.classList.add("dark");
    window.aiosToggleTheme = function () {
      var isDark = document.documentElement.classList.toggle("dark");
      try { localStorage.setItem("aios-timeline-theme", isDark ? "dark" : "light"); } catch (e) { /* file:// */ }
    };
  })();
`;

function avatarImg(
  assets: RenderAssets,
  subject: { login?: string | null; email?: string | null; name?: string | null }
): string {
  const label = subject.login ?? subject.name ?? "unknown";
  const src = assets.avatars.get(contributorKey(subject)) ?? initialsAvatarDataUri(label);
  return `<img src="${escapeHtml(src)}" alt="${escapeHtml(label)}" loading="lazy" />`;
}

function renderPrCard(pr: TimelinePr, audience: Audience, assets: RenderAssets): string {
  const shot = assets.shots.get(prKey(pr));
  const visual = shot
    ? `<img class="shot" src="${escapeHtml(shot)}" alt="${escapeHtml(pr.title)}" />`
    : `<div class="code-card"><span class="stat">${escapeHtml(diffStat(pr) || "code change")}</span><span>#${pr.number}</span></div>`;
  const title =
    audience === "team" && pr.url
      ? `<a href="${escapeHtml(pr.url)}">${escapeHtml(pr.title)}</a>`
      : escapeHtml(pr.title);
  const author = pr.author ?? "unknown";
  return `<article class="card">
    ${visual}
    <div class="card-body">
      <div class="card-title">${title}</div>
      <div class="byline">${avatarImg(assets, { login: pr.author })}<span>${escapeHtml(author)}</span><span class="date">${fmtDay(pr.mergedAt)}</span></div>
    </div>
  </article>`;
}

/** Render one audience's self-contained HTML page from an ALREADY-FILTERED dataset. */
export function renderTimeline(
  data: TimelineData,
  audience: Audience,
  assets: RenderAssets
): string {
  const filtered = filterForAudience(data, audience); // idempotent belt-and-suspenders
  const sections: string[] = [];
  for (const r of filtered.repos) {
    if (r.prs.length === 0 && r.commits.length === 0) continue;
    const cards = r.prs.map((pr) => renderPrCard(pr, audience, assets)).join("\n");
    const commits =
      r.commits.length === 0
        ? ""
        : `<ul class="commits">${r.commits
            .map(
              (commitRow) =>
                `<li><span class="sha">${escapeHtml(commitRow.sha.slice(0, 7))}</span><span>${escapeHtml(
                  commitRow.subject
                )}</span><span class="who">${escapeHtml(commitRow.authorLogin ?? commitRow.authorName)}</span></li>`
            )
            .join("")}</ul>`;
    const ghNote =
      audience === "team" && r.ghError
        ? `<div class="gh-note">merged-PR data unavailable (${escapeHtml(r.ghError)}) — showing commits only</div>`
        : "";
    sections.push(`<section class="repo">
      <h2>${escapeHtml(r.repo.alias)}</h2>
      <div class="repo-meta">${r.prs.length} merged PR${r.prs.length === 1 ? "" : "s"} · ${r.commits.length} commit${r.commits.length === 1 ? "" : "s"}</div>
      ${cards ? `<div class="cards">${cards}</div>` : ""}
      ${commits}
      ${ghNote}
    </section>`);
  }
  const body =
    sections.length > 0
      ? sections.join("\n")
      : `<p class="empty">Nothing shipped in this window${audience === "external" ? " (or nothing shareable at the external tier)" : ""}.</p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>AIOS — Week in review (${escapeHtml(fmtDay(filtered.since))} → ${escapeHtml(fmtDay(filtered.until))})</title>
<style>${assets.tokensCss}</style>
<style>${PAGE_CSS}</style>
<script>${THEME_SCRIPT}</script>
</head>
<body>
<div class="wrap">
  <header class="masthead">
    <div>
      <h1>Week in review</h1>
      <div class="range">${escapeHtml(fmtDay(filtered.since))} → ${escapeHtml(fmtDay(filtered.until))}</div>
    </div>
    <div style="display:flex; gap: var(--aios-space-3); align-items:center;">
      <span class="badge">${audience}</span>
      <button class="theme-toggle" onclick="aiosToggleTheme()">Light / Dark</button>
    </div>
  </header>
  ${body}
  <footer>Generated by <code>aios timeline</code> · ${escapeHtml(filtered.generatedAt)}</footer>
</div>
</body>
</html>
`;
}

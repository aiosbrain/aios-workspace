// Dual-audience renderer (AIO-208): tier filtering, external ⊂ team, escaping, avatar fallback,
// light/dark wiring.
import test from "node:test";
import assert from "node:assert/strict";

import {
  contributorKey,
  filterForAudience,
  initialsAvatarDataUri,
  prKey,
  renderTimeline,
  tiersForAudience,
} from "../../dist/timeline/index.js";

const TOKENS_FIXTURE = `:root { --aios-bg: #fafaf8; } .dark { --aios-bg: #0b0b0b; }`;

function repoResult(alias, tier, { prs = [], commits = [], ghError = null } = {}) {
  return { repo: { path: `/repos/${alias}`, alias, tier }, prs, commits, ghError };
}

function pr(repo, tier, number, title, author = "john-ellison") {
  return {
    repo,
    tier,
    number,
    title,
    author,
    mergedAt: "2026-06-30T10:00:00Z",
    url: `https://github.com/o/${repo}/pull/${number}`,
    additions: 10,
    deletions: 2,
    changedFiles: 3,
  };
}

function commitRow(repo, tier, sha, subject, name = "John") {
  return {
    repo,
    tier,
    sha,
    authorName: name,
    authorEmail: `${name.toLowerCase()}@example.com`,
    authorLogin: null,
    authoredAt: "2026-06-29T08:00:00Z",
    subject,
  };
}

const DATA = {
  generatedAt: "2026-07-01T12:00:00.000Z",
  since: "2026-06-24T00:00:00.000Z",
  until: "2026-07-01T00:00:00.000Z",
  repos: [
    repoResult("secret-client", "admin", {
      prs: [pr("secret-client", "admin", 1, "NDA-SENSITIVE-WORK")],
      commits: [commitRow("secret-client", "admin", "aaa0000", "hush")],
    }),
    repoResult("brain", "team", {
      prs: [pr("brain", "team", 2, "feat: ingest pipeline")],
      commits: [commitRow("brain", "team", "bbb0000", "chore: internal tidy")],
      ghError: "gh: rate limited",
    }),
    repoResult("website", "external", {
      prs: [pr("website", "external", 3, 'feat: hero <script>alert("x")</script>', "chetan-dev")],
      commits: [commitRow("website", "external", "ccc0000", "docs: public notes", "Chetan")],
    }),
  ],
};

const ASSETS = { tokensCss: TOKENS_FIXTURE, avatars: new Map(), shots: new Map() };

test("tiersForAudience: external is strictly narrower than team; admin is in neither", () => {
  assert.deepEqual([...tiersForAudience("team")].sort(), ["external", "team"]);
  assert.deepEqual([...tiersForAudience("external")], ["external"]);
});

test("filterForAudience: admin dropped everywhere; gh diagnostics team-only", () => {
  const team = filterForAudience(DATA, "team");
  assert.deepEqual(
    team.repos.map((r) => r.repo.alias),
    ["brain", "website"]
  );
  assert.equal(team.repos[0].ghError, "gh: rate limited");
  const ext = filterForAudience(DATA, "external");
  assert.deepEqual(
    ext.repos.map((r) => r.repo.alias),
    ["website"]
  );
  assert.equal(
    ext.repos.every((r) => r.ghError === null),
    true
  );
});

test("team render: full detail incl. team repos + PR links; admin content absent", () => {
  const html = renderTimeline(DATA, "team", ASSETS);
  assert.match(html, /feat: ingest pipeline/);
  assert.match(html, /docs: public notes/);
  assert.match(html, /href="https:\/\/github\.com\/o\/brain\/pull\/2"/);
  assert.match(html, /merged-PR data unavailable/);
  assert.doesNotMatch(html, /NDA-SENSITIVE-WORK/);
  assert.doesNotMatch(html, /secret-client/);
});

test("external render: strictly a subset — external tier only, no links, no gh notes", () => {
  const html = renderTimeline(DATA, "external", ASSETS);
  assert.match(html, /feat: hero/);
  assert.doesNotMatch(html, /feat: ingest pipeline/);
  assert.doesNotMatch(html, /chore: internal tidy/);
  assert.doesNotMatch(html, /NDA-SENSITIVE-WORK/);
  assert.doesNotMatch(html, /secret-client/);
  assert.doesNotMatch(html, /href="https:\/\/github\.com/);
  assert.doesNotMatch(html, /merged-PR data unavailable/);
});

test("HTML is escaped — a hostile PR title cannot inject markup", () => {
  const html = renderTimeline(DATA, "external", ASSETS);
  assert.doesNotMatch(html, /<script>alert\("x"\)<\/script>/);
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
});

test("both renders carry the tokens (light :root default + .dark) and a theme toggle", () => {
  for (const audience of ["team", "external"]) {
    const html = renderTimeline(DATA, audience, ASSETS);
    assert.match(html, /:root \{ --aios-bg: #fafaf8; \}/);
    assert.match(html, /\.dark \{ --aios-bg: #0b0b0b; \}/);
    assert.match(html, /prefers-color-scheme: dark/);
    assert.match(html, /aiosToggleTheme/);
    assert.match(html, new RegExp(`<span class="badge">${audience}</span>`));
  }
});

test("avatar fallback: no resolvable avatar → inline initials data URI (never a broken img)", () => {
  const html = renderTimeline(DATA, "external", ASSETS);
  assert.match(html, /src="data:image\/svg\+xml;base64,/);
  const uri = initialsAvatarDataUri("chetan-dev");
  const svg = Buffer.from(uri.split(",")[1], "base64").toString("utf8");
  assert.match(svg, />CD</);
});

test("provided assets are used: screenshot + avatar data URIs land in the card", () => {
  const assets = {
    tokensCss: TOKENS_FIXTURE,
    avatars: new Map([[contributorKey({ login: "chetan-dev" }), "data:image/png;base64,AVATAR"]]),
    shots: new Map([[prKey({ repo: "website", number: 3 }), "data:image/png;base64,SHOT"]]),
  };
  const html = renderTimeline(DATA, "external", assets);
  assert.match(html, /img class="shot" src="data:image\/png;base64,SHOT"/);
  assert.match(html, /src="data:image\/png;base64,AVATAR"/);
});

test("screenshot-less PR renders a code-change card with the diff stat", () => {
  const html = renderTimeline(DATA, "team", ASSETS);
  assert.match(html, /code-card/);
  assert.match(html, /3 files · \+10 · −2/);
});

// Timeline collector (AIO-205): normalization, login derivation, graceful gh degradation.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  collectRepo,
  collectTimeline,
  loginFromEmail,
  toSignals,
} from "../../dist/timeline/index.js";

const SEP = "\x1f";

function tempGitRepo(subjects) {
  const dir = mkdtempSync(path.join(tmpdir(), "tl-collect-"));
  const git = (...args) =>
    execFileSync(
      "git",
      ["-c", "user.name=Tester", "-c", "user.email=tester@example.com", ...args],
      {
        cwd: dir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
  git("init", "-q");
  for (const [i, subject] of subjects.entries()) {
    writeFileSync(path.join(dir, `f${i}.txt`), `${i}\n`);
    git("add", ".");
    git("commit", "-q", "-m", subject);
  }
  return dir;
}

test("loginFromEmail derives logins only from noreply addresses", () => {
  assert.equal(loginFromEmail("12345+octocat@users.noreply.github.com"), "octocat");
  assert.equal(loginFromEmail("octocat@users.noreply.github.com"), "octocat");
  assert.equal(loginFromEmail("someone@example.com"), null);
  assert.equal(loginFromEmail(""), null);
});

test("collectRepo: real git commits collected; gh failure degrades to commit-only", () => {
  const dir = tempGitRepo(["feat: first change", "fix: second change"]);
  try {
    const repo = { path: dir, alias: "sample", tier: "team" };
    const since = new Date(Date.now() - 3600_000).toISOString();
    const until = new Date(Date.now() + 3600_000).toISOString();
    // Default runner: real git works; `gh pr list` has no remote here → must not crash.
    const res = collectRepo(repo, since, until);
    assert.equal(res.commits.length, 2);
    assert.equal(res.prs.length, 0);
    assert.ok(res.ghError, "ghError should record the degradation");
    const first = res.commits.find((commitRow) => commitRow.subject === "feat: first change");
    assert.ok(first);
    assert.equal(first.repo, "sample");
    assert.equal(first.tier, "team");
    assert.equal(first.authorName, "Tester");
    assert.equal(first.authorLogin, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function stubRunner({ gitLines = [], ghJson = null, ghThrows = false }) {
  return (cmd, args) => {
    if (cmd === "git") return gitLines.join("\n");
    if (cmd === "gh") {
      if (ghThrows) throw new Error("gh: no remotes");
      return ghJson;
    }
    throw new Error(`unexpected cmd ${cmd} ${args.join(" ")}`);
  };
}

const NOW = "2026-07-01T12:00:00Z";
const SINCE = "2026-06-24T00:00:00.000Z";
const UNTIL = "2026-07-02T00:00:00.000Z";

test("collectRepo: PR rows normalized, window-filtered, squash commits deduped", () => {
  const repo = { path: "/x", alias: "web", tier: "external" };
  const gitLines = [
    [
      "aaa1111",
      "Chetan",
      "999+chetan-dev@users.noreply.github.com",
      "2026-06-30T10:00:00+00:00",
      "feat: landing page (#12)",
    ].join(SEP),
    [
      "bbb2222",
      "John",
      "john@example.com",
      "2026-06-29T10:00:00+00:00",
      "chore: tidy scripts",
    ].join(SEP),
  ];
  const ghJson = JSON.stringify([
    {
      number: 12,
      title: "feat: landing page",
      author: { login: "chetan-dev" },
      mergedAt: "2026-06-30T10:05:00Z",
      url: "https://github.com/o/r/pull/12",
      additions: 100,
      deletions: 4,
      changedFiles: 6,
    },
    // outside the window → dropped
    {
      number: 3,
      title: "old",
      author: { login: "x" },
      mergedAt: "2026-05-01T00:00:00Z",
      url: "https://github.com/o/r/pull/3",
    },
    // unmerged/malformed rows → dropped
    { number: 99, title: "no merge date", author: { login: "x" }, mergedAt: null, url: "" },
  ]);
  const res = collectRepo(repo, SINCE, UNTIL, stubRunner({ gitLines, ghJson }));
  assert.equal(res.ghError, null);
  assert.equal(res.prs.length, 1);
  const pr = res.prs[0];
  assert.deepEqual(
    { number: pr.number, author: pr.author, tier: pr.tier, additions: pr.additions },
    { number: 12, author: "chetan-dev", tier: "external", additions: 100 }
  );
  // the squash commit for #12 is deduped; the plain commit stays
  assert.deepEqual(
    res.commits.map((commitRow) => commitRow.sha),
    ["bbb2222"]
  );
  // noreply-derived login flows through on kept commits when present
  assert.equal(res.commits[0].authorLogin, null);
});

test("collectTimeline + toSignals: items inherit repo tier and project into the C1 shape", () => {
  const runner = stubRunner({
    gitLines: [
      ["ccc3333", "John", "j@example.com", "2026-06-28T09:00:00+00:00", "docs: notes"].join(SEP),
    ],
    ghThrows: true,
  });
  const data = collectTimeline(
    [
      { path: "/a", alias: "brain", tier: "team" },
      { path: "/b", alias: "site", tier: "external" },
    ],
    SINCE,
    UNTIL,
    runner,
    new Date(NOW)
  );
  assert.equal(data.generatedAt, new Date(NOW).toISOString());
  assert.equal(data.repos.length, 2);
  const signals = toSignals(data);
  assert.equal(signals.length, 2);
  for (const s of signals) {
    assert.equal(s.kind, "commit");
    assert.equal(s.source, "timeline");
    assert.ok(["team", "external"].includes(s.tier));
    assert.ok(s.ref.path.includes("@ccc3333".slice(0, 8)));
  }
});

// Screenshot pipeline (AIO-207): preview-URL extraction, target fallback chain, capture degradation.
import test from "node:test";
import assert from "node:assert/strict";

import { extractPreviewUrl, resolveShotTarget, captureShot } from "../../dist/timeline/index.js";

const PR = {
  repo: "web",
  tier: "external",
  number: 42,
  title: "feat: hero",
  author: "chetan-dev",
  mergedAt: "2026-06-30T10:00:00Z",
  url: "https://github.com/o/r/pull/42",
};

const VERCEL_COMMENT = JSON.stringify([
  { user: { login: "someone" }, body: "nice one" },
  {
    user: { login: "vercel[bot]" },
    body: "**web** | [Visit Preview](https://web-abc123-acme.vercel.app) | Jun 30",
  },
]);

test("extractPreviewUrl: finds the Vercel bot preview URL", () => {
  assert.equal(extractPreviewUrl(VERCEL_COMMENT), "https://web-abc123-acme.vercel.app");
});

test("extractPreviewUrl: prefers the bot comment but accepts any vercel.app URL", () => {
  const other = JSON.stringify([
    { user: { login: "human" }, body: "see https://thing-xyz.vercel.app/page ok" },
  ]);
  assert.equal(extractPreviewUrl(other), "https://thing-xyz.vercel.app/page");
  assert.equal(extractPreviewUrl("not json"), null);
  assert.equal(extractPreviewUrl(JSON.stringify([{ body: "no urls here" }])), null);
});

test("resolveShotTarget: preview → live → card fallback chain", () => {
  const repoWithLive = {
    path: "/x",
    alias: "web",
    tier: "external",
    liveUrl: "https://web.example",
  };
  // 1) gh returns a preview comment
  let t = resolveShotTarget(PR, repoWithLive, () => VERCEL_COMMENT);
  assert.deepEqual(t, { kind: "preview", url: "https://web-abc123-acme.vercel.app" });
  // 2) gh fails, live URL configured
  t = resolveShotTarget(PR, repoWithLive, () => {
    throw new Error("gh: not authenticated");
  });
  assert.deepEqual(t, { kind: "live", url: "https://web.example" });
  // 3) gh fails, no live URL → code-change card
  t = resolveShotTarget(PR, { path: "/x", alias: "cli", tier: "team" }, () => {
    throw new Error("gh: no remotes");
  });
  assert.deepEqual(t, { kind: "card", url: null });
  // 4) gh works but no preview in comments, no live URL → card
  t = resolveShotTarget(PR, { path: "/x", alias: "cli", tier: "team" }, () =>
    JSON.stringify([{ body: "lgtm" }])
  );
  assert.deepEqual(t, { kind: "card", url: null });
});

test("captureShot: success path drives open → wait → screenshot on one session", () => {
  const calls = [];
  const runner = (cmd, args) => {
    calls.push([cmd, ...args]);
    return "";
  };
  const res = captureShot("https://web.example", "/tmp/out.png", runner, "test-session");
  assert.equal(res.ok, true);
  assert.equal(res.path, "/tmp/out.png");
  assert.deepEqual(
    calls.map((cl) => cl[3]),
    ["open", "wait", "screenshot"]
  );
  assert.equal(calls[0][4], "https://web.example");
  assert.equal(calls[2][4], "/tmp/out.png");
  assert.ok(
    calls.every(
      (cl) => cl[0] === "agent-browser" && cl[1] === "--session" && cl[2] === "test-session"
    )
  );
});

test("captureShot: failures degrade to the code-change card, never throw", () => {
  // agent-browser missing entirely
  let res = captureShot("https://web.example", "/tmp/out.png", () => {
    throw new Error("spawn agent-browser ENOENT");
  });
  assert.equal(res.ok, false);
  assert.equal(res.path, null);
  assert.match(res.error, /ENOENT/);
  // networkidle timeout alone is tolerated — screenshot still taken
  const calls = [];
  res = captureShot(
    "https://web.example",
    "/tmp/out.png",
    (cmd, args) => {
      calls.push(args.join(" "));
      if (args.includes("wait")) throw new Error("timeout");
      return "";
    },
    "s"
  );
  assert.equal(res.ok, true);
  assert.equal(calls.length, 3);
});

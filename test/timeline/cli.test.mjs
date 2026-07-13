// `aios timeline` CLI (AIO-209/210): dry-run writes nothing and never touches agent-browser;
// full runs produce both audiences; the external render is fail-closed behind leak-gate.sh
// (leak → exit 2 + withheld; no term set → exit 3 + withheld). Follows the operator-loop CLI
// test conventions: child-process the real binary against temp fixtures.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(ROOT, "scripts", "aios.mjs");

const FORBIDDEN = "ZZZFORBIDDENCLIENTZZZ";

function gitRepo(dir, subjects) {
  mkdirSync(dir, { recursive: true });
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
}

function makeFixture({ leakInExternal = false } = {}) {
  const base = mkdtempSync(path.join(tmpdir(), "tl-cli-"));
  const ws = path.join(base, "workspace");
  mkdirSync(ws, { recursive: true });
  writeFileSync(path.join(ws, "README.md"), "# test workspace\n");

  const teamRepo = path.join(base, "internal-tool");
  gitRepo(teamRepo, ["feat: internal dashboards"]);
  const extRepo = path.join(base, "public-site");
  gitRepo(extRepo, [
    leakInExternal ? `feat: onboard ${FORBIDDEN} pilot` : "feat: public landing page",
  ]);

  mkdirSync(path.join(ws, ".aios"), { recursive: true });
  writeFileSync(
    path.join(ws, ".aios", "timeline-config.json"),
    JSON.stringify({ repos: { [extRepo]: { tier: "external", alias: "public-site" } } }, null, 2)
  );

  // PATH shim: any agent-browser invocation drops a marker file — dry-run and --no-shots
  // runs must leave it absent.
  const bin = path.join(base, "bin");
  mkdirSync(bin);
  const marker = path.join(base, "agent-browser-invoked");
  writeFileSync(path.join(bin, "agent-browser"), `#!/bin/sh\ntouch "${marker}"\nexit 0\n`);
  chmodSync(path.join(bin, "agent-browser"), 0o755);
  // gh shim: fail fast so PR collection deterministically degrades to commit-only
  writeFileSync(path.join(bin, "gh"), `#!/bin/sh\necho "gh: stubbed offline" >&2\nexit 1\n`);
  chmodSync(path.join(bin, "gh"), 0o755);

  const terms = path.join(base, "terms.sh");
  writeFileSync(terms, `STRONG='${FORBIDDEN}'\n`);

  return { base, ws, teamRepo, extRepo, marker, bin, terms };
}

function runCli(fx, args, { terms = fx.terms } = {}) {
  const env = {
    ...process.env,
    PATH: `${fx.bin}:${process.env.PATH}`,
    AIOS_LEAK_TERMS_FILE: terms,
    AIOS_LEAK_TERMS_B64: "",
    AIOS_BRAIN_URL: "",
    AIOS_API_KEY: "",
    NO_COLOR: "1",
  };
  try {
    const stdout = execFileSync(
      "node",
      [CLI, "timeline", "--workspace", fx.ws, "--since", "30d", ...args],
      { cwd: fx.ws, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }
    );
    return { status: 0, stdout, stderr: "" };
  } catch (e) {
    return { status: e.status, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

function timelineDirs(ws) {
  const dir = path.join(ws, ".aios", "timeline");
  return existsSync(dir) ? readdirSync(dir) : [];
}

test("--dry-run previews the plan, writes nothing, never calls agent-browser", () => {
  const fx = makeFixture();
  try {
    const res = runCli(fx, [
      "--repo",
      fx.teamRepo,
      "--repo",
      fx.extRepo,
      "--as",
      "all",
      "--dry-run",
      "--json",
    ]);
    assert.equal(res.status, 0, res.stderr);
    const plan = JSON.parse(res.stdout);
    assert.equal(plan.repos.length, 2);
    assert.equal(plan.commits, 2);
    assert.deepEqual(plan.audiences, ["team", "external"]);
    const ext = plan.repos.find((r) => r.alias === "public-site");
    assert.equal(ext.tier, "external");
    assert.deepEqual(timelineDirs(fx.ws), [], "dry-run must not write");
    assert.equal(existsSync(fx.marker), false, "dry-run must not invoke agent-browser");
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test("full run (--as all --no-shots): both HTML files, external strictly the external tier", () => {
  const fx = makeFixture();
  try {
    const res = runCli(fx, [
      "--repo",
      fx.teamRepo,
      "--repo",
      fx.extRepo,
      "--as",
      "all",
      "--no-shots",
      "--json",
    ]);
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.ok(out.files.team && out.files.external, "both renders written");
    const team = readFileSync(out.files.team, "utf8");
    const external = readFileSync(out.files.external, "utf8");
    assert.match(team, /internal dashboards/);
    assert.match(team, /public landing page/);
    assert.doesNotMatch(external, /internal dashboards/);
    assert.match(external, /public landing page/);
    assert.ok(existsSync(path.join(out.outDir, "data.json")));
    assert.equal(existsSync(fx.marker), false, "--no-shots must not invoke agent-browser");
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test("seeded NDA term in external content → external WITHHELD, exit 2 (fail-closed)", () => {
  const fx = makeFixture({ leakInExternal: true });
  try {
    const res = runCli(fx, [
      "--repo",
      fx.teamRepo,
      "--repo",
      fx.extRepo,
      "--as",
      "all",
      "--no-shots",
      "--json",
    ]);
    assert.equal(res.status, 2, `expected leak exit 2, got ${res.status}: ${res.stderr}`);
    assert.match(res.stderr, /WITHHELD/);
    const out = JSON.parse(res.stdout);
    assert.equal(out.withheld, "leak-detected");
    assert.equal(out.files.external, undefined);
    assert.ok(out.files.team, "team render still produced (team is the trusted audience)");
    // no external artifact — not even a withheld/failed copy — lands in the output dir
    assert.equal(existsSync(path.join(out.outDir, "index-external.html")), false);
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test("no term set configured → sweep unavailable → external WITHHELD, exit 3", () => {
  const fx = makeFixture();
  try {
    const res = runCli(fx, ["--repo", fx.extRepo, "--as", "external", "--no-shots", "--json"], {
      terms: path.join(fx.base, "does-not-exist.sh"),
    });
    assert.equal(res.status, 3, `expected exit 3, got ${res.status}: ${res.stderr}`);
    assert.match(res.stderr, /fail-closed/);
    const out = JSON.parse(res.stdout);
    assert.equal(out.withheld, "sweep-unavailable");
    assert.equal(out.files.external, undefined);
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test("--as team needs no sweep and exits 0 even without a term set", () => {
  const fx = makeFixture();
  try {
    const res = runCli(fx, ["--repo", fx.teamRepo, "--as", "team", "--no-shots", "--json"], {
      terms: path.join(fx.base, "does-not-exist.sh"),
    });
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.ok(out.files.team);
    assert.equal(out.withheld, null);
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test("no repos anywhere → clear error", () => {
  const fx = makeFixture();
  try {
    rmSync(path.join(fx.ws, ".aios", "timeline-config.json"));
    const res = runCli(fx, ["--dry-run"]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /timeline config not found/);
    assert.match(res.stderr, /docs\/feature-set\.md/);
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test("present config with no repos is distinguished from missing config", () => {
  const fx = makeFixture();
  try {
    writeFileSync(path.join(fx.ws, ".aios", "timeline-config.json"), '{"repos":{}}\n');
    const res = runCli(fx, ["--dry-run"]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /config contains no repos/);
    assert.doesNotMatch(res.stderr, /config not found/);
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

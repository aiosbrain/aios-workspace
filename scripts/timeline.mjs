/**
 * timeline.mjs — `aios timeline` (AIO-203): screenshot-rich weekly summaries,
 * team + external. Collector/renderer are TypeScript (dist/timeline), loaded
 * dynamically like the operator loop. The external render is fail-closed: it ships
 * ONLY when scripts/leak-gate.sh actually ran and came back clean — a skipped sweep
 * (no term set) withholds it, mirroring C6's no-manifest/leak-detected posture.
 * Exit codes: 0 ok · 2 leak detected · 3 sweep unavailable.
 *
 * Extracted from scripts/aios.mjs (AIO-315); behaviour-preserving.
 */

import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { c, die } from "./cli-common.mjs";
import { resolveBrainConfig } from "./brain-config.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

async function loadTimeline() {
  const distPath = path.join(SCRIPT_DIR, "..", "dist", "timeline", "index.js");
  if (!existsSync(distPath)) {
    die("timeline is not built — run: npm run build:loop");
  }
  return import(pathToFileURL(distPath).href);
}

function loadDesignTokensCss() {
  // tokens.css ships in @aios-alpha/design (a real dependency — token values are never
  // vendored into consumers, per aios-design/DESIGN.md).
  const p = path.join(
    SCRIPT_DIR,
    "..",
    "node_modules",
    "@aios-alpha",
    "design",
    "dist",
    "tokens.css"
  );
  if (!existsSync(p)) die("@aios-alpha/design is not installed — run: npm install");
  return readFileSync(p, "utf8");
}

async function fetchImageDataUri(url, timeoutMs = 10000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") || "image/png";
    if (!type.startsWith("image/")) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > 4 * 1024 * 1024) return null;
    return `data:${type.split(";")[0]};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

/** Run scripts/leak-gate.sh over a dir. → { verdict: "clean"|"leak"|"skipped", output } */
function runLeakGate(dir) {
  const gate = path.join(SCRIPT_DIR, "leak-gate.sh");
  let output = "";
  try {
    output = execFileSync("bash", [gate, dir], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    return { verdict: "leak", output: `${e.stdout || ""}${e.stderr || ""}` };
  }
  if (/SKIPPED/.test(output)) return { verdict: "skipped", output };
  return { verdict: "clean", output };
}

function parseTimelineDate(v, flag) {
  const rel = /^(\d+)d$/.exec(v || "");
  if (rel) return new Date(Date.now() - Number(rel[1]) * 86400_000).toISOString();
  const t = Date.parse(v || "");
  if (!Number.isFinite(t)) die(`${flag} must be an ISO date or <n>d (got '${v}')`);
  return new Date(t).toISOString();
}

export async function cmdTimeline(repo, cfg, args) {
  const tl = await loadTimeline();

  // ── flags ──
  let since = null;
  let until = null;
  let audience = "team";
  let configPath = null;
  let workspace = repo;
  const cliRepos = [];
  let dryRun = false;
  let noShots = false;
  let openAfter = false;
  let json = false;
  let maxShots = 16; // browser captures are ~10-30s each; the cap keeps a 60-PR week bounded
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--since") since = parseTimelineDate(args[++i], "--since");
    else if (a === "--until") until = parseTimelineDate(args[++i], "--until");
    else if (a === "--as") audience = args[++i] || "";
    else if (a === "--config") configPath = args[++i];
    else if (a === "--workspace") workspace = path.resolve(args[++i] || ".");
    else if (a === "--repo") {
      const v = args[++i];
      if (!v) die("--repo needs a value: <path>[=liveUrl]");
      const eq = v.indexOf("=");
      if (eq > 0) cliRepos.push({ path: v.slice(0, eq), liveUrl: v.slice(eq + 1) });
      else cliRepos.push({ path: v });
    } else if (a === "--max-shots") {
      maxShots = Number(args[++i]);
      if (!Number.isInteger(maxShots) || maxShots < 0)
        die("--max-shots must be a non-negative integer");
    } else if (a === "--dry-run") dryRun = true;
    else if (a === "--no-shots") noShots = true;
    else if (a === "--open") openAfter = true;
    else if (a === "--json") json = true;
    else die(`unknown timeline flag: ${a}`);
  }
  if (!["team", "external", "all"].includes(audience))
    die(`--as must be team|external|all; got '${audience}'`);
  const audiences = audience === "all" ? ["team", "external"] : [audience];
  since = since ?? new Date(Date.now() - 7 * 86400_000).toISOString();
  until = until ?? new Date().toISOString();

  // ── repos: CLI --repo entries, else everything in .aios/timeline-config.json ──
  const tlConfig = tl.loadTimelineConfig(workspace, configPath ?? undefined);
  let repoInputs = cliRepos;
  if (repoInputs.length === 0) {
    repoInputs = [...tlConfig.repos.keys()].map((p) => ({ path: p }));
  }
  if (repoInputs.length === 0) {
    die(
      "no repos: pass --repo <path>[=liveUrl] (repeatable) or configure .aios/timeline-config.json"
    );
  }
  const repos = tl.resolveRepos(repoInputs, tlConfig);
  for (const r of repos) {
    if (!existsSync(r.path)) die(`repo path does not exist: ${r.path}`);
  }

  // ── collect ──
  const data = tl.collectTimeline(repos, since, until);
  const teamView = tl.filterForAudience(data, "team");
  const prCount = teamView.repos.reduce((n, r) => n + r.prs.length, 0);
  const commitCount = teamView.repos.reduce((n, r) => n + r.commits.length, 0);
  const adminRepos = repos.filter((r) => r.tier === "admin").map((r) => r.alias);

  if (dryRun) {
    const plan = {
      since,
      until,
      audiences,
      repos: repos.map((r) => ({
        alias: r.alias,
        path: r.path,
        tier: r.tier,
        liveUrl: r.liveUrl ?? null,
      })),
      mergedPrs: prCount,
      commits: commitCount,
      screenshots: noShots ? 0 : teamView.repos.reduce((n, r) => n + r.prs.length, 0),
    };
    if (json) {
      console.log(JSON.stringify(plan, null, 2));
      return 0;
    }
    console.log(
      c.blue("aios timeline --dry-run") + c.dim(`  ${since.slice(0, 10)} → ${until.slice(0, 10)}`)
    );
    for (const r of repos)
      console.log(
        `  ${r.alias}  ${c.dim(`tier=${r.tier}${r.liveUrl ? ` live=${r.liveUrl}` : ""}`)}`
      );
    console.log(
      `  ${prCount} merged PR(s), ${commitCount} commit(s) in window · audiences: ${audiences.join(", ")}`
    );
    if (adminRepos.length)
      console.log(c.yellow(`  admin-tier (never rendered): ${adminRepos.join(", ")}`));
    console.log(c.dim("  dry-run: no screenshots captured, nothing written"));
    return 0;
  }

  const stamp = data.generatedAt.replace(/[:.]/g, "-");
  const outDir = path.join(workspace, ".aios", "timeline", stamp);
  const assetsDir = path.join(outDir, "assets");
  mkdirSync(assetsDir, { recursive: true });

  // ── avatars: brain roster first, GitHub CDN fallback, initials handled by the renderer ──
  const brain = resolveBrainConfig(workspace, { apiKeyEnv: cfg.api_key_env });
  const members = await tl.fetchBrainMembers({
    brainUrl: brain.brain_url,
    apiKey: brain.api_key,
    team: brain.team_id,
  });
  const avatars = new Map();
  const subjects = new Map(); // contributorKey → {login,email}
  for (const r of teamView.repos) {
    for (const pr of r.prs)
      if (pr.author) subjects.set(tl.contributorKey({ login: pr.author }), { login: pr.author });
    for (const commitRow of r.commits) {
      const s = { login: commitRow.authorLogin, email: commitRow.authorEmail };
      subjects.set(
        tl.contributorKey(
          s.login ? { login: s.login } : { email: s.email, name: commitRow.authorName }
        ),
        s
      );
    }
  }
  for (const [key, s] of subjects) {
    const url = tl.resolveAvatarUrl(s, members);
    if (!url) continue;
    const dataUri = await fetchImageDataUri(url);
    if (dataUri) avatars.set(key, dataUri);
  }

  // ── screenshots: Vercel preview → live URL → code-change card ──
  const shots = new Map();
  if (!noShots) {
    const byAlias = new Map(repos.map((r) => [r.alias, r]));
    // One capture per UNIQUE URL — a repo-level liveUrl fallback shared by N PRs is captured
    // once and reused, never N times. `null` marks a URL that already failed (no retries).
    // --max-shots caps capture ATTEMPTS (each is time-bounded, ~80s worst case), so total
    // browser time is deterministic no matter how many previews turn out to be auth-walled.
    const shotByUrl = new Map();
    // Unique session per run: a leftover daemon from a killed earlier run under the same
    // session name makes every command ETIMEDOUT against its dead socket.
    const shotSession = `aios-timeline-${process.pid}`;
    let captured = 0;
    let attempts = 0;
    const tryCapture = (pr, url, kind) => {
      if (shotByUrl.has(url)) {
        const cached = shotByUrl.get(url);
        if (cached) shots.set(tl.prKey(pr), cached);
        return cached !== null;
      }
      if (attempts >= maxShots) return false;
      attempts++;
      const file = path.join(assetsDir, `${pr.repo.replace(/[^\w-]/g, "_")}-${pr.number}.png`);
      const res = tl.captureShot(url, file, tl.execRunner, shotSession);
      if (res.ok && existsSync(file)) {
        const b64 = readFileSync(file).toString("base64");
        const uri = `data:image/png;base64,${b64}`;
        shotByUrl.set(url, uri);
        shots.set(tl.prKey(pr), uri);
        captured++;
        console.log(c.dim(`  shot ${tl.prKey(pr)} ← ${kind} ${url}`));
        return true;
      }
      shotByUrl.set(url, null);
      console.log(c.dim(`  shot ${tl.prKey(pr)} ${kind} failed (${res.error ?? "no image"})`));
      return false;
    };
    for (const r of teamView.repos) {
      const repoCfg = byAlias.get(r.repo.alias);
      for (const pr of r.prs) {
        const target = tl.resolveShotTarget(pr, repoCfg, tl.execRunner);
        if (!target.url) continue;
        const ok = tryCapture(pr, target.url, target.kind);
        // A dead preview (expired/auth-walled deploy) still deserves a visual when the repo
        // has a production URL — fall back to one shared live capture.
        if (!ok && target.kind === "preview" && repoCfg.liveUrl) {
          tryCapture(pr, repoCfg.liveUrl, "live");
        }
      }
    }
    tl.closeShotSession(tl.execRunner, shotSession);
    console.log(
      c.blue(`aios timeline`) + c.dim(`  ${captured} screenshot(s) from ${attempts} attempt(s)`)
    );
  }

  // ── render + fail-closed external sweep ──
  const assets = { tokensCss: loadDesignTokensCss(), avatars, shots };
  const files = {};
  let rc = 0;
  let withheld = null;
  for (const aud of audiences) {
    const html = tl.renderTimeline(data, aud, assets);
    const outFile = path.join(outDir, `index-${aud}.html`);
    if (aud === "external") {
      // Sweep in an isolated dir so the verdict covers exactly this artifact.
      const sweepDir = path.join(os.tmpdir(), `aios-timeline-sweep-${stamp}`);
      mkdirSync(sweepDir, { recursive: true });
      const sweepFile = path.join(sweepDir, "index-external.html");
      writeFileSync(sweepFile, html);
      const gate = runLeakGate(sweepDir);
      if (gate.verdict === "clean") {
        renameSync(sweepFile, outFile);
        rmSync(sweepDir, { recursive: true, force: true });
        files[aud] = outFile;
      } else if (gate.verdict === "leak") {
        rmSync(sweepDir, { recursive: true, force: true });
        withheld = "leak-detected";
        rc = 2;
        console.error(c.red("external render WITHHELD — leak-gate found forbidden identifiers:"));
        console.error(gate.output.trim());
      } else {
        rmSync(sweepDir, { recursive: true, force: true });
        withheld = "sweep-unavailable";
        rc = 3;
        console.error(
          c.red("external render WITHHELD — leak-gate has no term set configured (fail-closed).")
        );
        console.error(
          c.dim(
            "  configure ~/.config/aios-nda/leak-gate-terms.sh or $AIOS_LEAK_TERMS_FILE, or use --as team"
          )
        );
      }
    } else {
      writeFileSync(outFile, html);
      files[aud] = outFile;
    }
  }
  writeFileSync(path.join(outDir, "data.json"), JSON.stringify(data, null, 2));

  const result = { stamp, outDir, files, withheld, mergedPrs: prCount, commits: commitCount };
  if (json) console.log(JSON.stringify(result, null, 2));
  else {
    for (const [aud, f] of Object.entries(files)) console.log(c.green(`  ${aud}: ${f}`));
    if (withheld) console.log(c.yellow(`  external: withheld (${withheld})`));
  }
  if (openAfter && process.platform === "darwin") {
    const target = files.team ?? files.external;
    if (target) execFileSync("open", [target], { stdio: "ignore" });
  }
  return rc;
}

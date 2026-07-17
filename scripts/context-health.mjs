/**
 * context-health.mjs — "Context Engineering Health": a single score for how well a repo's
 * agent-facing context (CLAUDE.md/RESOLVER.md/AGENTS.md, the resolver, tier frontmatter,
 * the decision log, the toolkit sync, the skills catalog) actually holds up.
 *
 * Two modes, auto-detected from the target path:
 *   "workspace" — a scaffolded personal workspace (`.aios-toolkit-version` present).
 *   "repo"      — the aios-workspace toolkit repo itself (or any other repo without a stamp).
 *
 * Each check is `{ id, label, kind: "hard"|"soft", ok, value, detail }`. Hard checks are
 * structural facts that must hold (missing/broken references); soft checks are health
 * signals with a threshold in SOFT_THRESHOLDS — a soft check whose signal is unavailable
 * (no git, no toolkit checkout, no file) reports `value: null` and counts as `ok`, never as
 * a failure or a miss.
 *
 * Optional fact-table files (both YAML but hand-parsed rather than via parseFlatYaml,
 * which only supports flat scalars/lists — these need lists-of-records):
 *   .claude/resolver-fixtures.yaml   `fixtures: [{ intent, expected }, …]`
 *   .aios/context-facts.yaml        `facts: [{ file, needles: […] }, …]` — needles are
 *                                    plain substrings that must appear verbatim in `file`.
 *
 * Zero dependencies (node:* builtins only).
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { execSync, execFileSync } from "node:child_process";
import path from "node:path";
import { parseFrontmatter } from "./workspace-parse.mjs";
import { missingSeedPaths, resolveLocalToolkitDir, gitSha } from "./update.mjs";
import { toolkitMeta } from "./toolkit-meta.mjs";
import { readSkills, renderSkillsIndexMd } from "./gen-catalog.mjs";

export const SOFT_THRESHOLDS = {
  staleness_versions: 2,
  tier_coverage_pct: 80,
  decision_recency_days: 14,
  claude_coverage_pct: 60,
  resolver_coverage_pct: 80,
};

const SPINE_DIRS = [
  "0-context",
  "1-inbox",
  "2-work",
  "3-log",
  "4-shared",
  "5-personal",
  "6-business",
];

// ── tiny shared helpers ──────────────────────────────────────────────────────

function readIf(p) {
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

/** Recursively list every `.md` file under `dir` (repo-relative paths), skipping node_modules/.git. */
function listMdFiles(root, dir = root, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git") continue;
    const abs = path.join(dir, name);
    const stat = statSync(abs);
    if (stat.isDirectory()) listMdFiles(root, abs, out);
    else if (name.endsWith(".md")) out.push(path.relative(root, abs));
  }
  return out;
}

/**
 * Minimal parser for the one YAML shape our fact tables use: a top-level `key:` list of
 * flat records, where each record may itself contain one nested scalar-list field
 * (`needles:` / no nested field for fixtures). Not a general YAML parser — deliberately
 * narrow, matching the hand-authored fixture files it reads.
 *
 *   top:
 *     - field: "value"
 *       field2: "value"
 *       listField:
 *         - "a"
 *         - "b"
 *     - field: "value2"
 */
function parseRecordList(text, topKey) {
  const lines = text.split("\n");
  const records = [];
  let cur = null;
  let curListField = null;
  const topRe = new RegExp(`^${topKey}:\\s*$`);
  let inTop = false;
  for (const raw of lines) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    if (!inTop) {
      if (topRe.test(raw)) inTop = true;
      continue;
    }
    const recordStart = raw.match(/^\s*-\s+([A-Za-z0-9_]+):\s*(.*)$/);
    const nestedListItem = raw.match(/^\s*-\s+"?([^"]*?)"?\s*$/);
    const field = raw.match(/^\s+([A-Za-z0-9_]+):\s*(.*)$/);
    if (recordStart) {
      const [, key, val] = recordStart;
      cur = {};
      records.push(cur);
      curListField = null;
      if (val === "") {
        curListField = key;
        cur[key] = [];
      } else {
        cur[key] = stripQuotesLocal(val);
      }
      continue;
    }
    if (cur && field) {
      const [, key, val] = field;
      if (val === "") {
        curListField = key;
        cur[key] = [];
      } else {
        curListField = null;
        cur[key] = stripQuotesLocal(val);
      }
      continue;
    }
    if (cur && curListField && nestedListItem) {
      cur[curListField].push(stripQuotesLocal(nestedListItem[1]));
      continue;
    }
  }
  return records;
}

function stripQuotesLocal(s) {
  const t = s.trim().replace(/\s+#.*$/, "");
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

function mode(repoPath) {
  return existsSync(path.join(repoPath, ".aios-toolkit-version")) ? "workspace" : "repo";
}

// ── shared check: context-facts (both modes) ────────────────────────────────

function checkContextFacts(repoPath) {
  const p = path.join(repoPath, ".aios", "context-facts.yaml");
  const text = readIf(p);
  if (text === null)
    return { ok: true, value: null, detail: "no .aios/context-facts.yaml (skipped)" };
  const records = parseRecordList(text, "facts");
  let failing = 0;
  const misses = [];
  for (const { file, needles } of records) {
    if (!file) continue;
    const content = readIf(path.join(repoPath, file));
    for (const needle of needles || []) {
      if (content === null || !content.includes(needle)) {
        failing++;
        misses.push(`${file}: "${needle}"`);
      }
    }
  }
  return {
    ok: failing === 0,
    value: failing,
    detail:
      failing === 0
        ? `${records.length} fact row(s) all present`
        : `${failing} missing fact(s): ${misses.slice(0, 3).join("; ")}${misses.length > 3 ? ", …" : ""}`,
  };
}

// ── workspace-mode checks ────────────────────────────────────────────────────

function checkPlaceholderResidue(repoPath) {
  const candidates = ["CLAUDE.md", path.join(".claude", "CLAUDE.md"), "RESOLVER.md", "AGENTS.md"];
  let count = 0;
  const hits = [];
  for (const rel of candidates) {
    const text = readIf(path.join(repoPath, rel));
    if (text === null) continue;
    const matches = text.match(/\{\{[A-Z_]+\}\}/g) || [];
    if (matches.length) {
      count += matches.length;
      hits.push(`${rel} (${matches.length})`);
    }
  }
  return {
    ok: count === 0,
    value: count,
    detail: count === 0 ? "no unstamped placeholders" : `residue in ${hits.join(", ")}`,
  };
}

function checkResolverFixtures(repoPath) {
  const fixturesPath = path.join(repoPath, ".claude", "resolver-fixtures.yaml");
  const text = readIf(fixturesPath);
  if (text === null)
    return { ok: true, value: null, detail: "no .claude/resolver-fixtures.yaml (skipped)" };
  const resolverText = readIf(path.join(repoPath, "RESOLVER.md")) || "";
  const records = parseRecordList(text, "fixtures");
  const failing = records.filter((r) => r.expected && !resolverText.includes(r.expected));
  return {
    ok: failing.length === 0,
    value: failing.length,
    detail:
      failing.length === 0
        ? `${records.length} fixture(s) route to something in RESOLVER.md`
        : `${failing.length} fixture(s) whose expected route isn't in RESOLVER.md: ${failing
            .slice(0, 3)
            .map((r) => r.expected)
            .join(", ")}`,
  };
}

// [[wikilink]] / [[wikilink|label]] / [[wikilink#anchor]] — the workspace navigation-link
// form (scripts/aios.mjs's cmdGraph instead scans `[text](path.md)` markdown links via a
// reachability walk from an index.md seed; that form is also used heavily as ILLUSTRATIVE
// SYNTAX inside rule/rubric docs — e.g. "use markdown links: `[text](path.md)`" — so a
// blanket exhaustive scan for it produces false positives that cmdGraph's seeded-graph
// walk never encounters. [[wikilinks]] don't have that ambiguity in this codebase, so this
// check stays scoped to them: a minimal, non-graph scan — collect every md file's
// basename, then flag any [[target]] with no matching basename anywhere in the workspace.
const WIKILINK_RE = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;

function checkBrokenLinks(repoPath) {
  const files = listMdFiles(repoPath);
  const basenames = new Set(files.map((f) => path.basename(f)));
  let broken = 0;
  const examples = [];
  for (const rel of files) {
    const text = readIf(path.join(repoPath, rel));
    if (text === null) continue;
    WIKILINK_RE.lastIndex = 0;
    let m;
    while ((m = WIKILINK_RE.exec(text)) !== null) {
      const target = m[1].trim();
      const targetBase = target.endsWith(".md") ? target : `${target}.md`;
      if (!basenames.has(path.basename(targetBase))) {
        broken++;
        if (examples.length < 3) examples.push(`${rel} -> [[${target}]]`);
      }
    }
  }
  return {
    ok: broken === 0,
    value: broken,
    detail:
      broken === 0
        ? `${files.length} md file(s), no broken [[wikilink]]s`
        : `${broken} broken: ${examples.join("; ")}`,
  };
}

function checkToolkitStaleness(repoPath) {
  const stampPath = path.join(repoPath, ".aios-toolkit-version");
  const stamp = readIf(stampPath);
  if (stamp === null) return { ok: true, value: null, detail: "no toolkit stamp" };
  const haveSha = stamp.split(/\s/)[0];
  const toolkitDir = resolveLocalToolkitDir();
  if (!toolkitDir)
    return { ok: true, value: null, detail: "no local toolkit checkout to compare against" };
  const headSha = gitSha(toolkitDir);
  if (haveSha === "unknown" || headSha === "unknown")
    return { ok: true, value: null, detail: "toolkit git history unavailable" };
  if (headSha.startsWith(haveSha) || haveSha.startsWith(headSha)) {
    const meta = toolkitMeta(toolkitDir);
    return { ok: true, value: 0, detail: `up to date (${meta.label})` };
  }
  let count;
  try {
    count = parseInt(
      execFileSync("git", ["-C", toolkitDir, "rev-list", "--count", `${haveSha}..${headSha}`], {
        encoding: "utf8",
      }).trim(),
      10
    );
  } catch {
    return { ok: true, value: null, detail: "stamped sha not found in toolkit history" };
  }
  if (!Number.isFinite(count))
    return { ok: true, value: null, detail: "couldn't compute commits-behind" };
  return {
    ok: count <= SOFT_THRESHOLDS.staleness_versions,
    value: count,
    detail: `${count} commit(s) behind toolkit HEAD`,
  };
}

function checkTierCoverage(repoPath) {
  let total = 0;
  let covered = 0;
  for (const dir of SPINE_DIRS) {
    const abs = path.join(repoPath, dir);
    if (!existsSync(abs)) continue;
    for (const rel of listMdFiles(abs)) {
      const text = readIf(path.join(abs, rel));
      if (text === null) continue;
      total++;
      const { frontmatter } = parseFrontmatter(text);
      if (frontmatter && frontmatter.access) covered++;
    }
  }
  if (total === 0) return { ok: true, value: null, detail: "no spine content yet" };
  const pct = Math.round((covered / total) * 100);
  return {
    ok: pct >= SOFT_THRESHOLDS.tier_coverage_pct,
    value: pct,
    detail: `${covered}/${total} spine file(s) (${pct}%) have resolvable access: frontmatter`,
  };
}

function checkDecisionRecency(repoPath) {
  const p = path.join(repoPath, "3-log", "decision-log.md");
  const text = readIf(p);
  if (text === null) return { ok: true, value: null, detail: "no 3-log/decision-log.md" };
  const dates = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("|")) continue;
    for (const m of t.matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g)) dates.push(m[1]);
  }
  if (!dates.length) return { ok: true, value: null, detail: "no dated decision rows yet" };
  const newest = dates.map((d) => new Date(d)).reduce((a, b) => (b > a ? b : a));
  const days = Math.floor((Date.now() - newest.getTime()) / (1000 * 60 * 60 * 24));
  return {
    ok: days <= SOFT_THRESHOLDS.decision_recency_days,
    value: days,
    detail: `newest decision ${days}d old`,
  };
}

function checkMissingSeeds(repoPath) {
  const toolkitDir = resolveLocalToolkitDir();
  if (!toolkitDir)
    return { ok: true, value: null, detail: "no local toolkit checkout to compare against" };
  let missing;
  try {
    missing = missingSeedPaths(toolkitDir, repoPath);
  } catch {
    return { ok: true, value: null, detail: "couldn't evaluate seed paths" };
  }
  return {
    ok: missing.length === 0,
    value: missing.length,
    detail:
      missing.length === 0 ? "no missing seed files" : `missing: ${missing.slice(0, 3).join(", ")}`,
  };
}

// ── repo-mode checks ─────────────────────────────────────────────────────────

function checkVersionLabels(repoPath) {
  const brainApiPath = path.join(repoPath, "docs", "brain-api.md");
  const brainApiText = readIf(brainApiPath);
  if (brainApiText === null)
    return { ok: true, value: null, detail: "no docs/brain-api.md (non-toolkit repo)" };
  const claudeText = readIf(path.join(repoPath, "CLAUDE.md")) || "";

  // Prefer "Document revision: N.M" (the label CLAUDE.md's pinned-contract section tracks);
  // fall back to "Version: N.M" (toolkit-meta.mjs's brainApiVersion() anchor) if absent.
  const docRev = brainApiText.match(/\*\*Document revision:\s*([0-9]+\.[0-9]+)\*\*/)?.[1];
  const version = brainApiText.match(/\*\*Version:\s*([0-9]+\.[0-9]+)\*\*/)?.[1];
  const label = docRev || version;
  if (!label)
    return {
      ok: false,
      value: null,
      detail: "docs/brain-api.md header has no Version/Document revision label",
    };

  const claudeLabels = new Set(
    (claudeText.match(/\bv?(\d+\.\d+)\b/g) || []).map((s) => s.replace(/^v/, ""))
  );
  const found = claudeLabels.has(label);
  return {
    ok: found,
    value: found ? label : `expected ${label}, not referenced`,
    detail: found
      ? `CLAUDE.md references brain-api ${label}`
      : `CLAUDE.md doesn't mention brain-api's current label (${label}); docs/brain-api.md and CLAUDE.md have drifted`,
  };
}

function checkContextsList(repoPath) {
  const scaffoldScript = path.join(repoPath, "scripts", "scaffold-project.sh");
  const text = readIf(scaffoldScript);
  if (text === null) return { ok: true, value: null, detail: "no scripts/scaffold-project.sh" };
  const claudeText = readIf(path.join(repoPath, "CLAUDE.md")) || "";

  const caseBlock = text.match(/case\s+"\$CONTEXT"\s+in([\s\S]*?)esac/);
  const supported = new Set();
  if (caseBlock) {
    for (const m of caseBlock[1].matchAll(/^\s*([a-z][a-z-]*)\)/gm)) supported.add(m[1]);
  }
  const missing = [...supported].filter(
    (ctx) => !claudeText.includes(`--context ${ctx}`) && !claudeText.includes(ctx)
  );
  return {
    ok: missing.length === 0,
    value: missing.length,
    detail:
      missing.length === 0
        ? `CLAUDE.md names all ${supported.size} supported context(s)`
        : `CLAUDE.md doesn't mention: ${missing.join(", ")}`,
  };
}

function checkSkillCount(repoPath) {
  const indexPath = path.join(repoPath, "scaffold", ".claude", "skills", "INDEX.md");
  const skillsDir = path.join(repoPath, "scaffold", ".claude", "skills");
  const text = readIf(indexPath);
  if (text === null || !existsSync(skillsDir))
    return { ok: true, value: null, detail: "no scaffold skills catalog" };
  const claimed = parseInt(text.match(/ships \*\*(\d+)\*\* skill/)?.[1] ?? "-1", 10);
  const actual = readSkills(
    repoPath.endsWith("/scaffold") ? repoPath : path.join(repoPath, "scaffold")
  ).length;
  return {
    ok: claimed === actual,
    value: `${claimed}/${actual}`,
    detail:
      claimed === actual
        ? `INDEX.md's claimed count matches ${actual} SKILL.md dir(s)`
        : `INDEX.md claims ${claimed} skill(s), scaffold/.claude/skills has ${actual}`,
  };
}

function checkTierVocabPair(repoPath) {
  const frontmatterPath = path.join(repoPath, "scaffold", ".claude", "rules", "frontmatter.md");
  // The hub copy lives OUTSIDE this repo (monorepo sibling). A single-repo checkout
  // (CI, standalone clone, worktree container) legitimately doesn't have it — skip
  // there; the check is hard only when the sibling actually exists.
  const vocabPath = path.join(repoPath, "..", "docs", "tier-vocabulary.md");
  const b = readIf(vocabPath);
  if (b === null)
    return {
      ok: true,
      value: null,
      detail: "skipped — sibling docs/tier-vocabulary.md not present (single-repo checkout)",
    };
  const a = readIf(frontmatterPath);
  if (a === null)
    return {
      ok: false,
      value: null,
      detail: "scaffold/.claude/rules/frontmatter.md missing while hub tier-vocabulary.md exists",
    };

  const KNOWN = ["admin", "team", "external", "private", "personal", "client", "company"];
  const extract = (text) => {
    const stripped = text.replace(/```[\s\S]*?```/g, "");
    const set = new Set();
    for (const m of stripped.matchAll(/`([^`\n]+)`/g)) {
      for (const word of m[1].split(/[^a-z]+/i)) {
        const w = word.toLowerCase();
        if (KNOWN.includes(w)) set.add(w);
      }
    }
    return set;
  };
  const setA = extract(a);
  const setB = extract(b);
  const missing = [...setB].filter((w) => !setA.has(w));
  const extra = [...setA].filter((w) => !setB.has(w));
  const ok = missing.length === 0 && extra.length === 0;
  return {
    ok,
    value: ok ? setA.size : missing.length + extra.length,
    detail: ok
      ? `tier vocab in sync (${[...setA].sort().join(", ")})`
      : `tier vocab drift — missing from scaffold copy: [${missing.join(", ")}], extra: [${extra.join(", ")}]`,
  };
}

// Directories that carry source (excludes docs/test/vendor); "directory" = first path
// segment of a repo-relative path, and only counts when the path actually has one (a
// file sitting at repo root is not a directory).
function topLevelSourceDirs(repoPath) {
  let out;
  try {
    out = execSync("git log --name-only --since=90.days --pretty=format:", {
      cwd: repoPath,
      encoding: "utf8",
    });
  } catch {
    return null;
  }
  const counts = new Map();
  for (const line of out.split("\n")) {
    const rel = line.trim();
    if (!rel || !rel.includes("/")) continue;
    const seg = rel.split("/")[0];
    if (seg === "docs" || seg === "test" || seg === "node_modules") continue;
    counts.set(seg, (counts.get(seg) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([dir]) => dir);
}

function hasClaudeMdAtOrAbove(repoPath, dir) {
  if (existsSync(path.join(repoPath, "CLAUDE.md"))) return true; // root counts for all
  let cur = dir;
  while (true) {
    if (existsSync(path.join(repoPath, cur, "CLAUDE.md"))) return true;
    if (!cur.includes("/")) return false;
    cur = cur.slice(0, cur.lastIndexOf("/"));
  }
}

function checkClaudeCoverage(repoPath) {
  const dirs = topLevelSourceDirs(repoPath);
  if (dirs === null) return { ok: true, value: null, detail: "git log unavailable" };
  if (!dirs.length) return { ok: true, value: null, detail: "no churn in the last 90 days" };
  const covered = dirs.filter((d) => hasClaudeMdAtOrAbove(repoPath, d));
  const pct = Math.round((covered.length / dirs.length) * 100);
  return {
    ok: pct >= SOFT_THRESHOLDS.claude_coverage_pct,
    value: pct,
    detail: `${covered.length}/${dirs.length} high-churn dir(s) (${pct}%) have a CLAUDE.md at/above`,
  };
}

function checkResolverCoverage(repoPath) {
  const dirs = topLevelSourceDirs(repoPath);
  const resolverText = readIf(path.join(repoPath, "RESOLVER.md"));
  if (resolverText === null) return { ok: true, value: null, detail: "no RESOLVER.md" };
  if (dirs === null) return { ok: true, value: null, detail: "git log unavailable" };
  if (!dirs.length) return { ok: true, value: null, detail: "no churn in the last 90 days" };
  const covered = dirs.filter((d) => resolverText.includes(d));
  const pct = Math.round((covered.length / dirs.length) * 100);
  return {
    ok: pct >= SOFT_THRESHOLDS.resolver_coverage_pct,
    value: pct,
    detail: `${covered.length}/${dirs.length} high-churn dir(s) (${pct}%) named in RESOLVER.md`,
  };
}

function checkCatalogDrift(repoPath) {
  const scaffoldDir = path.join(repoPath, "scaffold");
  const indexPath = path.join(scaffoldDir, ".claude", "skills", "INDEX.md");
  const actual = readIf(indexPath);
  if (actual === null) return null; // no scaffold skills catalog — not applicable, not counted
  const built = renderSkillsIndexMd(readSkills(scaffoldDir));
  const ok = built === actual;
  return {
    id: "catalog-drift",
    label: "Skills catalog matches generator",
    kind: "hard",
    ok,
    value: ok ? 0 : 1,
    detail: ok
      ? "scaffold/.claude/skills/INDEX.md matches `node scripts/gen-catalog.mjs --repo scaffold`"
      : "scaffold/.claude/skills/INDEX.md is stale — re-run `node scripts/gen-catalog.mjs --repo scaffold`",
  };
}

// ── scoring ──────────────────────────────────────────────────────────────────

function band(hardFailures, softMisses) {
  if (hardFailures >= 2) return 0;
  if (hardFailures === 1) return 1;
  if (softMisses >= 2) return 2;
  if (softMisses === 1) return 3;
  return 4;
}

function summarize(mode, checks, hardFailures, softMisses, score) {
  if (hardFailures > 0) {
    const bad = checks.filter((c) => c.kind === "hard" && !c.ok);
    return `${score}/4 — ${hardFailures} hard failure(s): ${bad.map((c) => c.id).join(", ")}`;
  }
  if (softMisses === 0) return `${score}/4 — all checks clean`;
  const bad = checks.filter((c) => c.kind === "soft" && !c.ok);
  if (softMisses === 1) return `${score}/4 — hard checks clean, ${bad[0].detail}`;
  return `${score}/4 — hard checks clean, ${softMisses} soft miss(es): ${bad.map((c) => c.id).join(", ")}`;
}

/**
 * Compute the Context Engineering Health for `repoPath`. See module header for the check
 * catalog. `opts` is currently unused (reserved for future overrides, e.g. a fixed "now").
 */
export function computeContextHealth(repoPath, opts = {}) {
  void opts;
  const m = mode(repoPath);
  const checks = [];

  const push = (id, label, kind, result) => {
    if (result === null) return; // not applicable in this repo — silently omitted
    checks.push({ id, label, kind, ...result });
  };

  if (m === "workspace") {
    push(
      "placeholder-residue",
      "No unstamped {{PLACEHOLDER}} residue",
      "hard",
      checkPlaceholderResidue(repoPath)
    );
    push(
      "resolver-fixtures",
      "Resolver fixtures route correctly",
      "hard",
      checkResolverFixtures(repoPath)
    );
    push("broken-links", "No broken internal links", "hard", checkBrokenLinks(repoPath));
    push(
      "context-facts",
      "Context fact-table needles present",
      "hard",
      checkContextFacts(repoPath)
    );
    push("toolkit-staleness", "Toolkit sync is current", "soft", checkToolkitStaleness(repoPath));
    push(
      "tier-coverage",
      "Spine content has access: frontmatter",
      "soft",
      checkTierCoverage(repoPath)
    );
    push("decision-recency", "Decision log is current", "soft", checkDecisionRecency(repoPath));
    push("missing-seeds", "No missing seed files", "soft", checkMissingSeeds(repoPath));
  } else {
    push("version-labels", "brain-api version label in sync", "hard", checkVersionLabels(repoPath));
    push(
      "contexts-list",
      "CLAUDE.md lists all supported contexts",
      "hard",
      checkContextsList(repoPath)
    );
    push("skill-count", "Skill INDEX.md count matches reality", "hard", checkSkillCount(repoPath));
    push(
      "tier-vocab-pair",
      "Tier vocabulary in sync (hub + scaffold)",
      "hard",
      checkTierVocabPair(repoPath)
    );
    push(
      "context-facts",
      "Context fact-table needles present",
      "hard",
      checkContextFacts(repoPath)
    );
    const catalogDrift = checkCatalogDrift(repoPath);
    if (catalogDrift) checks.push(catalogDrift);
    push(
      "claude-coverage",
      "High-churn dirs have a CLAUDE.md",
      "soft",
      checkClaudeCoverage(repoPath)
    );
    push(
      "resolver-coverage",
      "High-churn dirs named in RESOLVER.md",
      "soft",
      checkResolverCoverage(repoPath)
    );
  }

  const hardFailures = checks.filter((c) => c.kind === "hard" && !c.ok).length;
  const softMisses = checks.filter((c) => c.kind === "soft" && !c.ok).length;
  const score = band(hardFailures, softMisses);
  const summary = summarize(m, checks, hardFailures, softMisses, score);

  return { mode: m, checks, hardFailures, softMisses, score, summary };
}

// Render a computeContextHealth result for the CLI (`aios context-health`). `colors` is
// the caller's ANSI helper object ({ bold, green, red, yellow } — each string→string).
export function renderContextHealth(result, target, colors) {
  const id = (fn, s) => (typeof fn === "function" ? fn(s) : s);
  const lines = [`${id(colors.bold, "Context health")}: ${target} (${result.mode} mode)`];
  for (const chk of result.checks) {
    const mark = chk.ok
      ? id(colors.green, "✓")
      : chk.kind === "hard"
        ? id(colors.red, "✗")
        : id(colors.yellow, "•");
    lines.push(`  ${mark} ${chk.label} — ${chk.detail}`);
  }
  lines.push(`\n  Context health: ${result.summary}`);
  const failing = result.checks.filter((chk) => !chk.ok).slice(0, 3);
  if (failing.length) {
    lines.push("\n  Fix hints:");
    for (const chk of failing)
      lines.push(`    ${chk.kind === "hard" ? "✗" : "•"} ${chk.id}: ${chk.detail}`);
  }
  return lines.join("\n");
}

// CLI entry for `aios context-health` — kept here (not in aios.mjs) so the dispatcher
// stays under its size cap; aios.mjs passes its ANSI color helper through.
export function runContextHealthCli(repo, args = [], colors = {}) {
  const target = path.resolve(args.find((a) => !a.startsWith("--")) || repo);
  const result = computeContextHealth(target);
  if (args.includes("--json")) console.log(JSON.stringify(result, null, 2));
  else console.log(renderContextHealth(result, target, colors));
}

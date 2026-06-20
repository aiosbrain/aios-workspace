// agent-readiness-lib.mjs — shared scoring engine for codebase agent-readiness.
//
// Single source of scoring logic, consumed by:
//   - validation/check-agent-readiness.mjs  (OGR10, advisory)
//   - scripts/aios.mjs  (`aios assess-codebase`, offline/read-only)
//
// The rubric itself is data: validation/agent-readiness.rubric.json, vendored from
// the monorepo-canonical agentic-engineering-maturity/rubric/agent-readiness.json.
// Scoring never hard-codes checks — change the rubric, not this file.

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const IGNORE_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  ".astro",
  "coverage",
  ".cache",
  ".turbo",
  "tmp",
  ".aios",
]);
const MAX_FILES = 40000;

export function loadRubric(rubricPath) {
  const p = rubricPath || path.join(SCRIPT_DIR, "agent-readiness.rubric.json");
  return JSON.parse(readFileSync(p, "utf8"));
}

// Walk the repo once, returning repo-relative POSIX paths (dirs end with "/").
function indexRepo(repo) {
  const out = [];
  const walk = (dir, rel, depth) => {
    if (out.length > MAX_FILES || depth > 12) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length > MAX_FILES) return;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name)) continue;
        out.push(childRel + "/");
        walk(path.join(dir, e.name), childRel, depth + 1);
      } else {
        out.push(childRel);
      }
    }
  };
  walk(repo, "", 0);
  return out;
}

function globToRegex(glob) {
  // Supports **, *, and literal segments. ** matches across "/", * does not.
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else re += "[^/]*";
    } else if (".+^${}()|[]\\".includes(c)) {
      re += "\\" + c;
    } else if (c === "{") {
      re += "(";
    } else if (c === "}") {
      re += ")";
    } else if (c === ",") {
      re += "|";
    } else {
      re += c;
    }
  }
  return new RegExp("^(.*/)?" + re + "$");
}

const isGlob = (s) => s.includes("*") || s.includes("{");

function readFileSafe(repo, rel) {
  try {
    return readFileSync(path.join(repo, rel), "utf8");
  } catch {
    return null;
  }
}

function fileBytes(repo, rel) {
  try {
    return statSync(path.join(repo, rel)).size;
  } catch {
    return -1;
  }
}

// Resolve dependency names from common manifests (best-effort).
function repoDependencies(repo) {
  const deps = new Set();
  const pkg = readFileSafe(repo, "package.json");
  if (pkg) {
    try {
      const j = JSON.parse(pkg);
      for (const k of [
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies",
      ]) {
        for (const name of Object.keys(j[k] || {})) deps.add(name);
      }
    } catch {
      /* ignore */
    }
  }
  for (const f of [
    "pyproject.toml",
    "requirements.txt",
    "poetry.lock",
    "Pipfile",
    "go.mod",
    "Cargo.toml",
    "Gemfile",
  ]) {
    const text = readFileSafe(repo, f);
    if (text) deps.add("__raw__:" + f + ":" + text.toLowerCase());
  }
  return deps;
}

function hasDependency(depSet, name) {
  if (depSet.has(name)) return true;
  const lower = name.toLowerCase();
  for (const d of depSet) {
    if (d.startsWith("__raw__:") && d.includes(lower)) return true;
  }
  return false;
}

// Evaluate one check's signal against the indexed repo. Returns boolean.
function evalSignal(signal, ctx) {
  const { repo, index, deps } = ctx;
  let matched = false;

  const matchPath = (pattern) => {
    if (isGlob(pattern)) {
      const re = globToRegex(pattern);
      return index.some((p) => re.test(p.replace(/\/$/, "")));
    }
    // literal file or dir
    return existsSync(path.join(repo, pattern));
  };

  if (signal.anyFileExists) matched = matched || signal.anyFileExists.some(matchPath);
  if (signal.anyPathMatches) matched = matched || signal.anyPathMatches.some(matchPath);

  if (!matched && signal.fileMinBytes) {
    const { anyOf, bytes } = signal.fileMinBytes;
    matched = anyOf.some((f) => fileBytes(repo, f) >= bytes);
  }
  if (!matched && signal.orConfigKey) {
    matched = signal.orConfigKey.some((c) => {
      const text = readFileSafe(repo, c.file);
      if (!text) return false;
      if (c.key) {
        try {
          return c.key in JSON.parse(text);
        } catch {
          return false;
        }
      }
      if (c.section) return text.includes("[" + c.section);
      return false;
    });
  }
  if (!matched && signal.orFileContains) {
    matched = signal.orFileContains.some((c) => {
      const text = readFileSafe(repo, c.file);
      if (!text) return false;
      return (c.anyOf || []).some((needle) => text.includes(needle));
    });
  }
  if (!matched && signal.orDependency) {
    matched = signal.orDependency.some((name) => hasDependency(deps, name));
  }
  return matched;
}

export function scoreRepo(repo, rubric) {
  rubric = rubric || loadRubric();
  const index = indexRepo(repo);
  const deps = repoDependencies(repo);
  const ctx = { repo, index, deps };

  const results = rubric.checks.map((c) => ({
    id: c.id,
    pillar: c.pillar,
    level: c.level,
    title: c.title,
    pass: evalSignal(c.signal, ctx),
  }));

  const levelOrder = rubric.levels.map((l) => l.id); // ["L1".."L5"]
  const levelIndex = (id) => levelOrder.indexOf(id);

  // Cumulative ratio at each level: checks with level <= k.
  const ratioAt = (k) => {
    const subset = results.filter((r) => levelIndex(r.level) <= k);
    const passed = subset.filter((r) => r.pass).length;
    return { passed, total: subset.length, ratio: subset.length ? passed / subset.length : 1 };
  };

  // Repo level = highest k where every level up to k clears the threshold.
  let level = 0; // 0 = pre-functional (below L1)
  for (let k = 0; k < levelOrder.length; k++) {
    if (ratioAt(k).ratio >= rubric.advanceThreshold) level = k + 1;
    else break;
  }

  // Verification cap: cannot exceed capLevel with zero passing checks in the cap pillar.
  const capPillarPasses = results.filter(
    (r) => r.pillar === rubric.verificationCapPillar && r.pass
  ).length;
  let capped = false;
  if (capPillarPasses === 0 && level > rubric.verificationCapLevel) {
    level = rubric.verificationCapLevel;
    capped = true;
  }

  const levelId = level === 0 ? "L0" : levelOrder[level - 1];
  const levelMeta = rubric.levels.find((l) => l.id === levelId) || {
    id: "L0",
    name: "Pre-functional",
    blurb: "Does not yet clear L1.",
  };

  // Overall composite %.
  const passedAll = results.filter((r) => r.pass).length;
  // 2-decimal to match the Team Brain Python scanner (round(x, 2)) + the numeric(5,2) column.
  const pct = Math.round((passedAll / results.length) * 10000) / 100;

  // Pillar rollup.
  const pillars = rubric.pillars.map((p) => {
    const subset = results.filter((r) => r.pillar === p.key);
    return {
      key: p.key,
      title: p.title,
      passed: subset.filter((r) => r.pass).length,
      total: subset.length,
    };
  });

  // Gaps to the NEXT level, ranked by remediationOrder.
  const nextLevelIdx = level; // 0-based index of the next level to clear
  const order = rubric.remediationOrder || results.map((r) => r.id);
  const failing = results.filter((r) => !r.pass);
  const nextLevelFailing = failing.filter((r) => levelIndex(r.level) <= nextLevelIdx);
  const rank = (id) => {
    const i = order.indexOf(id);
    return i === -1 ? 999 : i;
  };
  const gaps = (nextLevelFailing.length ? nextLevelFailing : failing)
    .sort((a, b) => rank(a.id) - rank(b.id))
    .map((r) => ({ id: r.id, title: r.title, level: r.level, pillar: r.pillar }));

  const nextLevelId = level < levelOrder.length ? levelOrder[level] : null;

  return {
    rubricVersion: rubric.version,
    level: levelId,
    levelName: levelMeta.name,
    levelBlurb: levelMeta.blurb,
    nextLevel: nextLevelId,
    pct,
    passed: passedAll,
    total: results.length,
    capped,
    pillars,
    checks: results,
    gaps,
  };
}

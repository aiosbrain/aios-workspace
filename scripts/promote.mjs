/**
 * promote.mjs — `aios promote <file> [--to <dest>] [--dry-run]` (AIO-353).
 *
 * The anonymize-then-promote pipeline for reusable IP: consultant/employee workspaces
 * accumulate reusable material (case studies, portfolio pieces, deliverable templates)
 * that starts private and is MEANT to eventually go team- or client/company-facing once
 * anonymized. This command is the documented, safe way to make that move:
 *
 *   1. Source must sit in a private / outside-sync location (5-personal/, or any
 *      top-level dir the workspace's own aios.yaml doesn't list in sync_include —
 *      e.g. a workspace-local `6-business/portfolio` staging area).
 *   2. COPY (never move) into the destination — the raw original is untouched.
 *   3. Scan the copy with the SAME mechanisms `aios push` already gates on: the shared
 *      secret-pattern list (validation/secret-patterns.txt via cli-common.mjs) and the
 *      confidentiality leak-gate (scripts/leak-gate.sh). Any hit deletes the copy.
 *   4. Inject/rewrite explicit `access:` frontmatter matching the destination tier.
 *   5. Append a row to 3-log/decision-log.md recording the promotion.
 *
 * `--dry-run` prints the plan and performs no writes, no copy, and no scan.
 * Zero new dependencies (Node builtins only); leak-gate.sh is shelled out to.
 */

import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  unlinkSync,
  statSync,
} from "node:fs";
import { c, die, loadSecretPatterns, findSecret } from "./cli-common.mjs";
import { parseFrontmatter, normalizeTier, parseDecisionRows } from "./workspace-parse.mjs";

const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);

// Always treated as a private/outside-sync source, canonical + legacy spine names.
const KNOWN_PRIVATE_DIRS = new Set(["5-personal", "05-personal"]);

const DEST_ALIASES = {
  "2-work": "2-work",
  team: "2-work",
  "02-deliverables": "02-deliverables",
  "4-shared": "4-shared",
  external: "4-shared",
  client: "4-shared",
  company: "4-shared",
  "04-client-surface": "04-client-surface",
};
const TEAM_DEST_DIRS = new Set(["2-work", "02-deliverables"]);
const EXTERNAL_DEST_DIRS = new Set(["4-shared", "04-client-surface"]);

/**
 * Is `sourceAbs` in a private/outside-sync location? Always true for 5-personal/
 * (canonical) and 05-personal/ (legacy spine). Otherwise "detect from the workspace
 * tree": any other top-level directory this workspace's aios.yaml does NOT list in
 * `sync_include` is, by the default-deny rule, already outside-sync — eligible as a
 * promotion source (covers e.g. a workspace-local `6-business/portfolio`).
 */
export function classifySource(repo, cfg, sourceAbs) {
  const rel = path.relative(repo, sourceAbs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    return { ok: false, rel, reason: "source is outside the workspace repo" };
  }
  const top = rel.split(path.sep)[0];
  if (KNOWN_PRIVATE_DIRS.has(top)) return { ok: true, rel, top };
  const included = new Set((cfg?.sync_include || []).map((p) => p.split("/")[0]));
  if (!included.has(top)) return { ok: true, rel, top };
  return {
    ok: false,
    rel,
    top,
    reason:
      `'${top}/' already syncs (listed in aios.yaml sync_include) — promote only works from a ` +
      `private/outside-sync location (5-personal/, or a workspace-local staging dir like 6-business/)`,
  };
}

/** Friendly outward-tier label for this workspace's context (consultant → client, employee → company). */
export function outwardLabel(cfg) {
  return cfg?.context === "employee" ? "company" : "client";
}

/**
 * Resolve `--to <dest>` (or a bare tier alias) against the source's basename into a
 * concrete { ok: true, destRel, destDirName, tier } — pure, no filesystem access, no
 * process exit (returns `{ ok: false, reason }` on an unrecognized value so callers,
 * including tests, can handle the failure without a process.exit). `tier` is the
 * FRIENDLY access label to write into frontmatter (team | client | company). Returns
 * `null` when `toArg` is empty — the caller's cue to prompt interactively.
 */
export function resolveDestination(toArg, sourceBasename, cfg) {
  if (!toArg || !toArg.trim()) return null;
  const raw = toArg.trim().replace(/\/+$/, "");
  const bareAlias = DEST_ALIASES[raw];

  let destRel;
  let destDirName;
  if (bareAlias) {
    // A bare tier/dir name ("2-work", "team", "4-shared", "client", ...) — file keeps its
    // basename directly under that root.
    destDirName = bareAlias;
    destRel = path.join(destDirName, sourceBasename);
  } else {
    // A fuller relative path, e.g. "2-work/case-studies/foo.md" — must live under a known
    // team or external root.
    const top = raw.split("/")[0];
    if (!TEAM_DEST_DIRS.has(top) && !EXTERNAL_DEST_DIRS.has(top)) {
      return {
        ok: false,
        reason:
          `--to '${toArg}' must be 2-work/ (team) or 4-shared/ (external), a friendly alias ` +
          `(team|external|client|company), or a path under one of those roots`,
      };
    }
    destDirName = top;
    destRel = raw;
  }

  const tier = TEAM_DEST_DIRS.has(destDirName)
    ? "team"
    : raw === "client" || raw === "company"
      ? raw
      : outwardLabel(cfg);
  return { ok: true, destRel, destDirName, tier };
}

/**
 * Rewrite (or inject) the `access:` frontmatter field on `content`. Everything else in
 * an existing frontmatter block is preserved verbatim (line-level rewrite, not a
 * parse+reserialize round-trip, so field order/formatting never drifts). Content with
 * no frontmatter gets the minimal block per scaffold/.claude/rules/frontmatter.md.
 */
export function rewriteFrontmatter(content, tierLabel, owner) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) {
    const block = `---\nstatus: draft\nowner: ${owner}\naccess: ${tierLabel}\n---\n\n`;
    return block + content;
  }
  const fmLines = m[1].split(/\r?\n/);
  let found = false;
  const rewritten = fmLines.map((line) => {
    if (/^access:\s*/.test(line)) {
      found = true;
      return `access: ${tierLabel}`;
    }
    return line;
  });
  if (!found) rewritten.push(`access: ${tierLabel}`);
  return (
    content.slice(0, m.index) + `---\n${rewritten.join("\n")}\n---\n` + content.slice(m[0].length)
  );
}

/** Locate this workspace's decision log (canonical, falling back to the legacy spine name). */
export function decisionLogPath(repo) {
  const canonical = path.join(repo, "3-log", "decision-log.md");
  if (existsSync(canonical)) return canonical;
  const legacy = path.join(repo, "03-status", "decision-log.md");
  if (existsSync(legacy)) return legacy;
  return canonical;
}

/**
 * Append one "newest first" row to the decision log's markdown table. Inserted directly
 * after the header separator row (see scaffold/.claude/rules/decision-log.md).
 */
export function appendDecisionRow(logContent, row) {
  const lines = logContent.split(/\r?\n/);
  const sepIdx = lines.findIndex((l) => /^\|[\s:|-]+\|$/.test(l.trim()));
  const newRow = `| ${row.n} | ${row.date} | ${row.decision} | ${row.rationale} | ${row.decidedBy} | ${row.impact} | ${row.type} | ${row.audience} |`;
  if (sepIdx === -1) {
    // No table found (fresh/empty log) — write the standard header + the new row.
    const header =
      "| # | Date | Decision | Rationale | Decided By | Impact | Type | Audience |\n" +
      "|---|------|----------|-----------|------------|--------|------|----------|";
    const prefix = logContent.trim() ? logContent.replace(/\s*$/, "") + "\n\n" : "";
    return `${prefix}${header}\n${newRow}\n`;
  }
  lines.splice(sepIdx + 1, 0, newRow);
  return lines.join("\n");
}

function nextDecisionNumber(logContent) {
  const { body } = parseFrontmatter(logContent);
  const rows = parseDecisionRows(body ?? logContent);
  let max = 0;
  for (const r of rows) {
    const n = parseInt(r.row_key, 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}

function isoDate(now) {
  return now.toISOString().slice(0, 10);
}

/** Default scan: shared secret patterns (in-process) + the confidentiality leak-gate (shelled out). */
function defaultScanFile(destAbs) {
  const findings = [];
  const content = readFileSync(destAbs, "utf8");
  const secretHit = findSecret(content, loadSecretPatterns());
  if (secretHit) findings.push(`secret pattern matched: ${secretHit}`);

  const leakGate = path.join(SCRIPT_DIR, "leak-gate.sh");
  if (existsSync(leakGate)) {
    try {
      execFileSync(leakGate, [destAbs], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      const out = [e.stdout, e.stderr].filter(Boolean).join("\n").trim();
      findings.push(out || "leak-gate: FAILED");
    }
  }
  return { clean: findings.length === 0, findings };
}

export async function cmdPromote(repo, cfg, args, opts = {}) {
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const dryRun = flags.has("--dry-run");
  const positional = args.filter((a) => !a.startsWith("--"));
  const sourceArg = positional[0];
  if (!sourceArg) {
    die("usage: aios promote <file> [--to 2-work|4-shared|team|client|company] [--dry-run]");
  }
  const toIdx = args.indexOf("--to");
  const toArg = toIdx >= 0 ? args[toIdx + 1] : null;

  const sourceAbs = path.isAbsolute(sourceArg) ? sourceArg : path.join(repo, sourceArg);
  if (!existsSync(sourceAbs) || !statSync(sourceAbs).isFile()) {
    die(`source not found (or not a file): ${sourceArg}`);
  }
  if (!sourceAbs.endsWith(".md")) {
    die("aios promote only supports markdown (.md) files — the frontmatter target");
  }

  const classified = classifySource(repo, cfg, sourceAbs);
  if (!classified.ok) die(`aios promote: ${classified.reason}`);

  const basename = path.basename(sourceAbs);
  let dest = resolveDestination(toArg, basename, cfg);
  if (dest && !dest.ok) die(dest.reason);
  if (!dest) {
    if (!process.stdin.isTTY) {
      die(
        "no --to given and stdin is not a TTY — pass --to 2-work (team) or --to 4-shared (external)"
      );
    }
    const readline = await import("node:readline/promises");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const label = outwardLabel(cfg);
    let answer;
    try {
      answer = await rl.question(
        `Promote '${classified.rel}' to: [1] 2-work (team)  [2] 4-shared (${label})\n> `
      );
    } finally {
      rl.close();
    }
    const choice = answer.trim();
    if (choice === "1" || choice.toLowerCase() === "2-work" || choice.toLowerCase() === "team") {
      dest = resolveDestination("2-work", basename, cfg);
    } else if (choice === "2" || choice.toLowerCase().includes("shared") || choice === label) {
      dest = resolveDestination("4-shared", basename, cfg);
    } else {
      die(`unrecognized choice: '${answer}'`);
    }
    if (dest && !dest.ok) die(dest.reason);
  }

  const destAbs = path.join(repo, dest.destRel);

  if (dryRun) {
    console.log(c.blue("aios promote") + c.dim("  (dry-run)"));
    console.log(`  source:      ${classified.rel}`);
    console.log(`  destination: ${dest.destRel}`);
    console.log(`  access:      ${dest.tier}`);
    console.log(
      c.dim("  no files written — copy, scan, frontmatter, and decision log are all skipped.")
    );
    return;
  }

  if (existsSync(destAbs)) {
    die(`destination already exists: ${dest.destRel} (promote never overwrites — remove it first)`);
  }

  mkdirSync(path.dirname(destAbs), { recursive: true });
  copyFileSync(sourceAbs, destAbs);

  const scanFile = opts.scanFile || defaultScanFile;
  const scan = await scanFile(destAbs);
  if (!scan.clean) {
    unlinkSync(destAbs);
    console.error(c.red("aios promote: leak/secret scan FAILED — promoted copy deleted."));
    for (const f of scan.findings) console.error(`  ${f}`);
    die("fix the source content and re-run promote.");
  }

  let owner = "unknown";
  if (opts.resolveMember) {
    try {
      owner = opts.resolveMember();
    } catch {
      /* best-effort — frontmatter owner falls back to 'unknown' rather than blocking promotion */
    }
  }
  const rawContent = readFileSync(destAbs, "utf8");
  const rewritten = rewriteFrontmatter(rawContent, dest.tier, owner);
  writeFileSync(destAbs, rewritten);

  const logPath = decisionLogPath(repo);
  const logContent = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
  const n = nextDecisionNumber(logContent);
  const now = opts.now ? opts.now() : new Date();
  const row = {
    n,
    date: isoDate(now),
    decision: `Promoted ${classified.rel} to ${dest.destRel} (reusable IP, anonymized)`,
    rationale: "Portfolio/reusable-IP staging: private draft matured to a wider audience",
    decidedBy: owner,
    impact: `${dest.destRel} carries access: ${dest.tier}; leak/secret scan clean`,
    type: 2,
    audience: normalizeTier(dest.tier),
  };
  mkdirSync(path.dirname(logPath), { recursive: true });
  writeFileSync(logPath, appendDecisionRow(logContent, row));

  console.log(c.green("✓") + ` promoted ${classified.rel} → ${dest.destRel}`);
  console.log(c.dim(`  access: ${dest.tier} · decision log entry #${n} · original untouched`));
}

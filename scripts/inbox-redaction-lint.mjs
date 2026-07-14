#!/usr/bin/env node
/**
 * Inbox governance lint (I-16 / AIO-397) — the deterministic CI backstop for the retention +
 * audit-anchor package. Reuses the `leak-sweep.ts` convention: pure string containment, never an
 * LLM judgment. Four checks, each exit-non-zero on failure:
 *
 *   1. redaction  — no message body / subject / participant string from the fixture corpus appears
 *                   in any telemetry fixture (the telemetry path must carry digests/counts only).
 *   2. inventory  — every canonical store the epic created is enumerated in the data-inventory doc
 *                   AND the retention table; a store named in the domain doc / retention.yaml but
 *                   missing from the inventory fails.
 *   3. runbook    — the IR runbook contains a `Revocation order` section (grep-able).
 *   4. adjectives — the package carries no adjective claims (`robust` / `secure` / `hardened`);
 *                   only concrete pass/fail facts are allowed.
 *
 * Usage:
 *   node scripts/inbox-redaction-lint.mjs [--check all|redaction|inventory|runbook|adjectives]
 *                                         [--telemetry <file>]... [--corpus <file>] [--json]
 *
 * `--telemetry <file>` (repeatable) REPLACES the default telemetry target set — used by the test to
 * point the redaction check at a dirty fixture. Exit 0 = all requested checks pass.
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const GOV_DIR = path.join(ROOT, "docs", "v1-operator-loop", "domains", "inbox-governance");
const FIXTURES_DIR = path.join(ROOT, "test", "operator-loop", "fixtures");
const INVENTORY_DOC = path.join(GOV_DIR, "data-inventory.md");
const RETENTION_YAML = path.join(GOV_DIR, "retention.yaml");
const RUNBOOK_DOC = path.join(GOV_DIR, "ir-runbook.md");

// The canonical stores the epic created — the reconcile target for check #2.
const CANONICAL_STORES = [
  "journal",
  "read_model",
  "observations",
  "snippets_body_cache",
  "outbox",
  "audit",
  "backups",
  "telemetry",
];

// Adjective claims banned anywhere in the package (word-boundaried, case-insensitive). `\bsecure\b`
// deliberately does NOT match "security" (as in "security-review") — a different word.
const BANNED_ADJECTIVES = [/\brobust\b/i, /\bsecure\b/i, /\bhardened\b/i];
// Files the adjective scan covers ("the package"): the governance docs + the engine + the lint's
// own fixtures. This script is excluded (it must name the banned words to ban them).
const PACKAGE_ADJECTIVE_TARGETS = [
  GOV_DIR,
  path.join(ROOT, "src", "operator-loop", "inbox", "audit.ts"),
  path.join(ROOT, "src", "operator-loop", "inbox", "retention.ts"),
];

function parseArgs(argv) {
  const out = { check: "all", telemetry: [], corpus: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") out.check = argv[++i];
    else if (a === "--telemetry") out.telemetry.push(argv[++i]);
    else if (a === "--corpus") out.corpus = argv[++i];
    else if (a === "--json") out.json = true;
    else if (a === "--help" || a === "-h") {
      console.log("usage: inbox-redaction-lint.mjs [--check <name>] [--telemetry <f>]... [--json]");
      process.exit(0);
    } else throw new Error(`unknown arg: ${a}`);
  }
  return out;
}

function walkFiles(base) {
  if (!existsSync(base)) return [];
  const st = statSync(base);
  if (st.isFile()) return [base];
  if (!st.isDirectory()) return [];
  const out = [];
  for (const entry of readdirSync(base)) out.push(...walkFiles(path.join(base, entry)));
  return out;
}

function corpusStrings(corpusPath) {
  const raw = JSON.parse(readFileSync(corpusPath, "utf8"));
  const strings = [];
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith("_")) continue;
    if (Array.isArray(v)) for (const s of v) if (typeof s === "string" && s.trim()) strings.push(s);
  }
  return strings;
}

// ── check: redaction ────────────────────────────────────────────────────────────────────────────
function checkRedaction(args) {
  const corpusPath = args.corpus ?? path.join(FIXTURES_DIR, "inbox-telemetry-corpus.fixture.json");
  if (!existsSync(corpusPath))
    return { name: "redaction", ok: false, errors: [`missing corpus: ${corpusPath}`] };
  const needles = corpusStrings(corpusPath);
  const targets =
    args.telemetry.length > 0
      ? args.telemetry.map((t) => (path.isAbsolute(t) ? t : path.join(process.cwd(), t)))
      : walkFiles(FIXTURES_DIR).filter((f) => /inbox-telemetry-.*\.jsonl$/.test(f));
  const errors = [];
  for (const file of targets) {
    if (!existsSync(file)) {
      errors.push(`telemetry target not found: ${file}`);
      continue;
    }
    const hay = readFileSync(file, "utf8").toLowerCase();
    for (const needle of needles) {
      if (hay.includes(needle.toLowerCase())) {
        errors.push(`${path.relative(ROOT, file)}: forbidden string present ("${needle}")`);
      }
    }
  }
  return { name: "redaction", ok: errors.length === 0, errors, scanned: targets.length };
}

// ── check: inventory reconcile ────────────────────────────────────────────────────────────────────
function checkInventory() {
  const errors = [];
  if (!existsSync(INVENTORY_DOC))
    return { name: "inventory", ok: false, errors: [`missing ${INVENTORY_DOC}`] };
  if (!existsSync(RETENTION_YAML))
    return { name: "inventory", ok: false, errors: [`missing ${RETENTION_YAML}`] };
  const inventory = readFileSync(INVENTORY_DOC, "utf8");
  const yaml = readFileSync(RETENTION_YAML, "utf8");

  // Stores declared in the retention table = top-level keys under `records:` (2-space indent).
  const yamlStores = [];
  let inRecords = false;
  for (const line of yaml.split("\n")) {
    if (/^records:\s*$/.test(line)) {
      inRecords = true;
      continue;
    }
    if (inRecords) {
      if (/^\S/.test(line) && line.trim()) break; // dedented back to top level → records block ended
      const m = line.match(/^ {2}([a-z0-9_]+):\s*$/);
      if (m) yamlStores.push(m[1]);
    }
  }

  // Every canonical store must be enumerated in the inventory doc as `store: <id>`.
  for (const store of CANONICAL_STORES) {
    if (!inventory.includes(`store: ${store}`)) {
      errors.push(
        `store "${store}" not enumerated in data-inventory.md (expected \`store: ${store}\`)`
      );
    }
  }
  // Every store named in the retention table must be enumerated in the inventory.
  for (const store of yamlStores) {
    if (!inventory.includes(`store: ${store}`)) {
      errors.push(`store "${store}" in retention.yaml but missing from data-inventory.md`);
    }
  }
  // And the table must cover every canonical store (no silent drop).
  for (const store of CANONICAL_STORES) {
    if (!yamlStores.includes(store)) {
      errors.push(`store "${store}" missing from retention.yaml records table`);
    }
  }
  return { name: "inventory", ok: errors.length === 0, errors, stores: yamlStores };
}

// ── check: runbook Revocation order ───────────────────────────────────────────────────────────────
function checkRunbook() {
  if (!existsSync(RUNBOOK_DOC))
    return { name: "runbook", ok: false, errors: [`missing ${RUNBOOK_DOC}`] };
  const text = readFileSync(RUNBOOK_DOC, "utf8");
  const ok = /Revocation order/.test(text);
  return {
    name: "runbook",
    ok,
    errors: ok ? [] : ["ir-runbook.md missing a `Revocation order` section"],
  };
}

// ── check: adjective claims ───────────────────────────────────────────────────────────────────────
function checkAdjectives() {
  const errors = [];
  const files = PACKAGE_ADJECTIVE_TARGETS.flatMap(walkFiles);
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      for (const re of BANNED_ADJECTIVES) {
        if (re.test(line)) {
          errors.push(`${path.relative(ROOT, file)}:${i + 1}: adjective claim "${re.source}"`);
        }
      }
    });
  }
  return { name: "adjectives", ok: errors.length === 0, errors };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const registry = {
    redaction: () => checkRedaction(args),
    inventory: checkInventory,
    runbook: checkRunbook,
    adjectives: checkAdjectives,
  };
  const names = args.check === "all" ? Object.keys(registry) : [args.check];
  const results = [];
  for (const n of names) {
    const fn = registry[n];
    if (!fn) throw new Error(`unknown check: ${n}`);
    results.push(fn());
  }
  const ok = results.every((r) => r.ok);
  if (args.json) {
    console.log(JSON.stringify({ ok, results }, null, 2));
  } else {
    for (const r of results) {
      if (r.ok) console.log(`✓ ${r.name}`);
      else {
        console.error(`✗ ${r.name}`);
        for (const e of r.errors) console.error(`    ${e}`);
      }
    }
  }
  process.exit(ok ? 0 : 1);
}

main();

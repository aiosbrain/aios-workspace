#!/usr/bin/env node
// instinct-candidate.mjs — SessionEnd hook that scans incidents/ for duplicate root-cause
// patterns and appends `status: candidate` lines to instincts.md. A candidate graduates to a
// rule after human review (or second confirmation by the memory-reviewer pipeline).
//
// Matching rule (per plan G4.2): two or more incidents share the same normalized root-cause
// field (lowercase, strip whitespace, max 120 chars) OR the same harness + same error-signature
// line in Root cause. Runs AFTER a session ends — read-only on turn data, write-only on
// instincts.md candidate lines.
//
// HARD RULE: must never block a session. Always exits 0. Precision over recall.

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const INCIDENTS_DIR = join(process.cwd(), ".claude", "memory", "incidents");
const INSTINCTS_PATH = join(process.cwd(), ".claude", "memory", "instincts.md");
const CANDIDATE_MARKER = "<!-- candidate:auto (unreviewed; ≥2 matching root causes) -->";
const ROOT_CAUSE_MAX = 120;
const ERR_SIG_MAX = 160;

function normalize(s) {
  return (s || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function parseFrontmatter(raw) {
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([a-z_]+):\s*(.*)$/i);
    if (kv) out[kv[1].toLowerCase()] = kv[2].trim();
  }
  return out;
}

function extractRootCause(body) {
  const m = body.match(/\*\*Root cause:?\*\*\s*(.+)/i);
  return m ? m[1].trim().slice(0, ROOT_CAUSE_MAX) : "";
}

function extractErrorSignature(body) {
  const m = body.match(/\*\*Error signature:?\*\*\s*(.+)/i);
  return m ? m[1].trim().slice(0, ERR_SIG_MAX) : "";
}

function scanIncidents() {
  if (!existsSync(INCIDENTS_DIR)) return [];

  const entries = readdirSync(INCIDENTS_DIR, { withFileTypes: true });
  const incidents = [];

  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".md") || e.name.startsWith("_")) continue;
    const raw = readFileSync(join(INCIDENTS_DIR, e.name), "utf8");
    const fm = parseFrontmatter(raw);
    if (fm.status === "distilled") continue; // already promoted

    const rootCause = extractRootCause(raw);
    const errSig = extractErrorSignature(raw);
    const harness = fm.harness || "";

    incidents.push({
      file: e.name,
      status: fm.status || "",
      harness: normalize(harness),
      rootCause: normalize(rootCause),
      errSig: normalize(errSig),
    });
  }

  return incidents;
}

function findCandidates(incidents) {
  const candidates = [];

  // Group by normalized root cause
  const byRootCause = new Map();
  for (const inc of incidents) {
    if (!inc.rootCause) continue;
    const key = inc.rootCause.slice(0, ROOT_CAUSE_MAX);
    if (!byRootCause.has(key)) byRootCause.set(key, []);
    byRootCause.get(key).push(inc);
  }

  for (const [, group] of byRootCause) {
    if (group.length < 2) continue;
    const files = group.map((i) => i.file);
    candidates.push({
      trigger: "root-cause",
      reason: `Same root cause in ${group.length} incidents`,
      cause: group[0].rootCause,
      files,
    });
  }

  // Group by harness + error signature
  const bySig = new Map();
  for (const inc of incidents) {
    if (!inc.errSig || !inc.harness) continue;
    const key = `${inc.harness}::${inc.errSig}`;
    if (!bySig.has(key)) bySig.set(key, []);
    bySig.get(key).push(inc);
  }

  for (const [, group] of bySig) {
    if (group.length < 2) continue;
    const files = group.map((i) => i.file);
    candidates.push({
      trigger: "error-signature",
      reason: `Same harness + error signature in ${group.length} incidents`,
      cause: `${group[0].harness}: ${group[0].errSig}`,
      files,
    });
  }

  return candidates;
}

function appendCandidates(candidates) {
  if (!candidates.length) return 0;

  let content;
  try {
    content = readFileSync(INSTINCTS_PATH, "utf8");
  } catch {
    return 0;
  }

  if (content.includes(CANDIDATE_MARKER)) {
    // Remove old candidate block, append fresh
    const idx = content.indexOf(CANDIDATE_MARKER);
    content = content.slice(0, idx).replace(/\s*$/, "");
  }

  let block = `\n\n${CANDIDATE_MARKER}\n`;
  for (const c of candidates) {
    const derived = c.files.map((f) => `incidents/${f}`).join(", ");
    block += `- **candidate** ${c.reason}: ${c.cause} — derived-from: ${derived}\n`;
  }

  const next = content + block + "\n";
  writeFileSync(INSTINCTS_PATH, next, "utf8");
  return candidates.length;
}

async function main() {
  let payload;
  try {
    const stdin = await readStdin();
    payload = stdin ? JSON.parse(stdin) : null;
  } catch {
    // no input → scan anyway from cwd
  }

  if (payload && payload.hook_event_name !== "Stop") return;

  try {
    const incidents = scanIncidents();
    const candidates = findCandidates(incidents);
    appendCandidates(candidates);
  } catch {
    // fail silently — never block a session
  }
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));

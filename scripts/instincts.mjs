/**
 * instincts.mjs — AM4b instinct distillation (AIO-230).
 *
 * Batch-reads correction observations from `.aios/loop/maturity/observations.ndjson`,
 * groups them by project + prior_hash, calls an injectable `distillFn` (default: `claude -p`),
 * validates candidates, and writes homunculus instinct records under
 * `<AIOS_HOMUNCULUS_DIR>/projects/<project_id>/instincts/personal/`.
 *
 * Test seams (clone spec-eval.mjs):
 *   AIOS_INSTINCTS_DISTILL_STUB — raw JSON text (or path); bypasses the default LLM call.
 *
 * Zero dependencies.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { c } from "./relay-core.mjs";
import { foldObservationsList, obsStorePath } from "./analyze/maturity-store.mjs";

const STATE_REL = ".aios/loop/maturity/instincts-state.json";
const STATE_VERSION = 1;
const CONFIDENCE_FLOOR = 0.4;

export function resolveHomunculusDir(env = process.env) {
  const raw = env.AIOS_HOMUNCULUS_DIR?.trim();
  if (raw) return path.resolve(raw);
  return path.join(homedir(), ".claude", "homunculus");
}

export function resolveProjectId(repo) {
  let hashSource = repo;
  try {
    const out = execFileSync("git", ["-C", repo, "remote", "get-url", "origin"], {
      encoding: "utf8",
      timeout: 5000,
    }).trim();
    if (out) hashSource = out;
  } catch {
    /* fallback: repo root path */
  }
  return createHash("sha256").update(hashSource).digest("hex").slice(0, 12);
}

export function instinctsStatePath(repo) {
  return path.join(repo, STATE_REL);
}

export function loadInstinctsState(repo) {
  const p = instinctsStatePath(repo);
  if (!existsSync(p)) {
    return { version: STATE_VERSION, lastCreatedAt: null, lastObsId: null };
  }
  try {
    const s = JSON.parse(readFileSync(p, "utf8"));
    return {
      version: STATE_VERSION,
      lastCreatedAt: s.lastCreatedAt ?? null,
      lastObsId: s.lastObsId ?? null,
    };
  } catch {
    return { version: STATE_VERSION, lastCreatedAt: null, lastObsId: null };
  }
}

export function saveInstinctsState(repo, state) {
  const p = instinctsStatePath(repo);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(
    p,
    JSON.stringify(
      {
        version: STATE_VERSION,
        lastCreatedAt: state.lastCreatedAt ?? null,
        lastObsId: state.lastObsId ?? null,
      },
      null,
      2
    )
  );
}

export function normalizeTrigger(trigger) {
  return String(trigger ?? "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export function slugFromTrigger(trigger) {
  const base = String(trigger ?? "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (base || "instinct").slice(0, 48);
}

function hex4(input) {
  return createHash("sha256").update(input).digest("hex").slice(0, 4);
}

export function instinctIdForTrigger(trigger, projectId) {
  return `instinct-${slugFromTrigger(trigger)}-${hex4(`${projectId}|${normalizeTrigger(trigger)}`)}`;
}

export function personalInstinctsDir(homunculusDir, projectId) {
  return path.join(homunculusDir, "projects", projectId, "instincts", "personal");
}

/** @returns {Map<string, { path: string, record: object }>} keyed by normalized trigger */
export function loadExistingInstincts(homunculusDir, projectId) {
  const dir = personalInstinctsDir(homunculusDir, projectId);
  const byTrigger = new Map();
  if (!existsSync(dir)) return byTrigger;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".md")) continue;
    const filePath = path.join(dir, name);
    try {
      const record = parseInstinctMarkdown(readFileSync(filePath, "utf8"));
      if (!record?.trigger) continue;
      byTrigger.set(normalizeTrigger(record.trigger), { path: filePath, record });
    } catch {
      /* skip unreadable */
    }
  }
  return byTrigger;
}

export function parseInstinctMarkdown(content) {
  const raw = String(content ?? "");
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fm) return null;
  const meta = {};
  for (const line of fm[1].split("\n")) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();
    if (key === "confidence") {
      meta.confidence = Number(value);
    } else if (key === "origin_obs") {
      const inner = value.match(/^\[(.*)\]$/)?.[1] ?? "";
      meta.origin_obs = inner
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else {
      meta[key] = value.replace(/^["']|["']$/g, "");
    }
  }
  const body = fm[2].trim();
  const contextMatch = body.match(/## Context\n([\s\S]*?)(?:\n## Action\n|$)/);
  const actionMatch = body.match(/## Action\n([\s\S]*)$/);
  return {
    ...meta,
    context: contextMatch ? contextMatch[1].trim() : "",
    action: actionMatch ? actionMatch[1].trim() : "",
    body,
  };
}

export function renderInstinctMarkdown(record) {
  const origin = Array.isArray(record.origin_obs) ? record.origin_obs : [];
  const originYaml = `[${origin.join(", ")}]`;
  return [
    "---",
    `id: ${record.id}`,
    `trigger: "${String(record.trigger).replace(/"/g, '\\"')}"`,
    `confidence: ${record.confidence}`,
    `domain: ${record.domain}`,
    "source: personal",
    "scope: project",
    `created_at: ${record.created_at}`,
    `origin_obs: ${originYaml}`,
    "---",
    "## Context",
    record.context,
    "## Action",
    record.action,
    "",
  ].join("\n");
}

export function validateCandidate(candidate) {
  const errors = [];
  if (!candidate || typeof candidate !== "object") {
    return { ok: false, errors: ["candidate is not an object"] };
  }
  for (const key of ["trigger", "action", "context", "domain"]) {
    if (typeof candidate[key] !== "string" || !candidate[key].trim()) {
      errors.push(`missing or empty ${key}`);
    }
  }
  const conf = Number(candidate.confidence);
  if (!Number.isFinite(conf)) errors.push("confidence is not a number");
  else if (conf < 0 || conf > 1) errors.push("confidence out of range 0..1");
  return { ok: errors.length === 0, errors, confidence: conf };
}

export function isAfterWatermark(obs, watermark) {
  if (!watermark?.lastCreatedAt) return true;
  const createdAt = obs.createdAt ?? "";
  if (createdAt > watermark.lastCreatedAt) return true;
  if (createdAt < watermark.lastCreatedAt) return false;
  const id = obs.id ?? "";
  const lastId = watermark.lastObsId ?? "";
  return id > lastId;
}

export function filterNewObservations(observations, watermark) {
  return observations.filter((obs) => isAfterWatermark(obs, watermark));
}

export function groupObservations(observations, projectId) {
  const groups = new Map();
  for (const obs of observations) {
    const key = `${projectId}|${obs.prior_hash ?? ""}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(obs);
  }
  return groups;
}

function buildDistillPrompt(observations) {
  const snippets = observations.map((o) => `- (${o.id}) ${o.snippet ?? ""}`).join("\n");
  return [
    "You distill operator correction observations into durable instinct records.",
    "Return ONLY a JSON object with this shape:",
    '{"candidates":[{"trigger":"when …","action":"…","context":"…","confidence":0.0,"domain":"workflow"}]}',
    "domain must be one of: workflow, communications, writing, coding, research.",
    "confidence is 0..1. Merge related corrections into one candidate when they share a theme.",
    "",
    "Observations:",
    snippets,
  ].join("\n");
}

/** Default distiller: `claude -p` JSON. Honors AIOS_INSTINCTS_DISTILL_STUB. */
export async function defaultDistillFn({ observations }) {
  const stub = process.env.AIOS_INSTINCTS_DISTILL_STUB;
  if (stub != null) return existsSync(stub) ? readFileSync(stub, "utf8") : stub;
  const prompt = buildDistillPrompt(observations);
  let out;
  try {
    out = execFileSync("claude", ["-p", "--model", "claude-haiku-4-5", "--output-format", "json"], {
      input: prompt,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (e) {
    throw new Error(`claude -p failed: ${e.stderr?.trim() || e.message}`);
  }
  return out;
}

export function parseDistillResponse(text) {
  const s = String(text ?? "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return { candidates: [], parseError: true };
  try {
    const obj = JSON.parse(s.slice(start, end + 1));
    const candidates = Array.isArray(obj?.candidates) ? obj.candidates : [];
    return { candidates, parseError: false };
  } catch {
    return { candidates: [], parseError: true };
  }
}

/**
 * Pure orchestration: group → distillFn → validate → write instinct files.
 * @returns {Promise<object>} summary counters + written/updated records
 */
export async function distillObservations({
  observations,
  distillFn,
  now = () => new Date(),
  homunculusDir,
  projectId,
  dryRun = false,
  existingByTrigger = null,
}) {
  const groups = groupObservations(observations, projectId);
  const existing = existingByTrigger ?? loadExistingInstincts(homunculusDir, projectId);
  const outDir = personalInstinctsDir(homunculusDir, projectId);

  const summary = {
    groups: groups.size,
    processedGroups: 0,
    candidates: 0,
    written: 0,
    updated: 0,
    droppedLowConfidence: 0,
    rejected: 0,
    warnings: [],
    records: [],
    watermarkObservations: [],
  };

  for (const [, groupObs] of groups) {
    summary.processedGroups += 1;
    const obsIds = groupObs.map((o) => o.id).filter(Boolean);

    let raw;
    if (dryRun) {
      summary.records.push({ dryRun: true, observationIds: obsIds, groupSize: groupObs.length });
      continue;
    }

    try {
      raw = await distillFn({
        observations: groupObs,
        projectId,
        priorHash: groupObs[0]?.prior_hash,
      });
    } catch (e) {
      summary.rejected += 1;
      summary.warnings.push(`distillFn threw: ${e.message}`);
      continue;
    }

    const { candidates, parseError } = parseDistillResponse(raw);
    if (parseError) {
      summary.rejected += 1;
      summary.warnings.push("distillFn returned unparseable JSON");
      continue;
    }

    let groupAccepted = 0;
    for (const candidate of candidates) {
      summary.candidates += 1;
      const v = validateCandidate(candidate);
      if (!v.ok) {
        summary.rejected += 1;
        summary.warnings.push(`invalid candidate: ${v.errors.join("; ")}`);
        continue;
      }
      if (v.confidence < CONFIDENCE_FLOOR) {
        summary.droppedLowConfidence += 1;
        continue;
      }

      const norm = normalizeTrigger(candidate.trigger);
      const existingEntry = existing.get(norm);
      const createdAt = now()
        .toISOString()
        .replace(/\.\d{3}Z$/, "Z");

      if (existingEntry) {
        const prev = existingEntry.record;
        const mergedObs = [...new Set([...(prev.origin_obs ?? []), ...obsIds])];
        const record = {
          id: prev.id,
          trigger: candidate.trigger,
          confidence: Math.max(Number(prev.confidence) || 0, v.confidence),
          domain: candidate.domain,
          created_at: prev.created_at ?? createdAt,
          origin_obs: mergedObs,
          context: candidate.context,
          action: candidate.action,
        };
        writeFileSync(existingEntry.path, renderInstinctMarkdown(record));
        existing.set(norm, { path: existingEntry.path, record });
        summary.updated += 1;
        summary.records.push({ id: record.id, updated: true, origin_obs: mergedObs });
      } else {
        mkdirSync(outDir, { recursive: true });
        const id = instinctIdForTrigger(candidate.trigger, projectId);
        const filePath = path.join(outDir, `${id}.md`);
        const record = {
          id,
          trigger: candidate.trigger,
          confidence: v.confidence,
          domain: candidate.domain,
          created_at: createdAt,
          origin_obs: obsIds,
          context: candidate.context,
          action: candidate.action,
        };
        writeFileSync(filePath, renderInstinctMarkdown(record));
        existing.set(norm, { path: filePath, record });
        summary.written += 1;
        summary.records.push({ id, written: true, origin_obs: obsIds });
      }
      groupAccepted += 1;
    }

    // Only advance the watermark past groups we successfully distilled (or that
    // legitimately yielded no candidates). Failed/thrown/rejected groups retry.
    if (groupAccepted > 0 || candidates.length === 0) {
      summary.watermarkObservations.push(...groupObs);
    }
  }

  return summary;
}

export function maxWatermark(observations) {
  let lastCreatedAt = null;
  let lastObsId = null;
  for (const obs of observations) {
    const createdAt = obs.createdAt ?? "";
    const id = obs.id ?? "";
    if (
      lastCreatedAt == null ||
      createdAt > lastCreatedAt ||
      (createdAt === lastCreatedAt && id > (lastObsId ?? ""))
    ) {
      lastCreatedAt = createdAt;
      lastObsId = id;
    }
  }
  return { lastCreatedAt, lastObsId };
}

export function readObservationsStore(repo) {
  const p = obsStorePath(repo);
  if (!existsSync(p)) return { observations: [], warnings: 0 };
  try {
    const { observations, warnings } = foldObservationsList(readFileSync(p, "utf8"));
    observations.sort((a, b) => {
      const ca = a.createdAt ?? "";
      const cb = b.createdAt ?? "";
      if (ca !== cb) return ca < cb ? -1 : 1;
      return (a.id ?? "") < (b.id ?? "") ? -1 : 1;
    });
    return { observations, warnings };
  } catch {
    return { observations: [], warnings: 1 };
  }
}

const HELP = [
  "aios instincts distill [--limit N] [--dry-run] [--json]",
  "",
  "  Batch-distill correction observations (.aios/loop/maturity/observations.ndjson)",
  "  into homunculus instinct records (admin-tier, local-only).",
  "",
  "  --limit N   process at most N observation groups (new since watermark)",
  "  --dry-run   print groups only; no LLM call, no writes",
  "  --json      machine-readable summary on stdout",
  "",
  "  Watermark: .aios/loop/maturity/instincts-state.json",
  "  Output:    $AIOS_HOMUNCULUS_DIR/projects/<project_id>/instincts/personal/<id>.md",
  "             (default homunculus dir: ~/.claude/homunculus)",
].join("\n");

export async function cmdInstincts(repo, args) {
  if (!args.length || args[0] === "--help" || args[0] === "-h") {
    console.log(HELP);
    return;
  }
  const sub = args[0];
  if (sub !== "distill") {
    console.error(c.red(`error: unknown subcommand '${sub}' (expected distill)`));
    process.exit(4);
  }

  const rest = args.slice(1);
  const has = (flag) => rest.includes(flag);
  const valOf = (flag) => {
    const i = rest.indexOf(flag);
    return i !== -1 ? rest[i + 1] : null;
  };
  const asJson = has("--json");
  const dryRun = has("--dry-run");
  const limitRaw = valOf("--limit");
  const limit = limitRaw != null ? parseInt(limitRaw, 10) : null;

  const stubbed = process.env.AIOS_INSTINCTS_DISTILL_STUB != null;
  if (!dryRun && !stubbed) {
    try {
      execFileSync("claude", ["--version"], { encoding: "utf8", timeout: 5000 });
    } catch {
      console.error(
        c.red(
          "error: `claude` CLI not available — use --dry-run, set AIOS_INSTINCTS_DISTILL_STUB, or install Claude Code."
        )
      );
      process.exit(4);
    }
  }

  const homunculusDir = resolveHomunculusDir();
  const projectId = resolveProjectId(repo);
  const state = loadInstinctsState(repo);
  const { observations, warnings: readWarnings } = readObservationsStore(repo);
  const fresh = filterNewObservations(observations, state);
  const groups = groupObservations(fresh, projectId);
  let toProcess = [...groups.values()];
  if (Number.isFinite(limit) && limit >= 0) toProcess = toProcess.slice(0, limit);
  const flatObs = toProcess.flat();

  const summary = await distillObservations({
    observations: flatObs,
    distillFn: defaultDistillFn,
    homunculusDir,
    projectId,
    dryRun,
  });

  if (!dryRun && summary.watermarkObservations.length) {
    const wm = maxWatermark(summary.watermarkObservations);
    saveInstinctsState(repo, wm);
  }

  const payload = {
    projectId,
    homunculusDir,
    newObservations: fresh.length,
    groupsAvailable: groups.size,
    groupsProcessed: summary.processedGroups,
    readWarnings,
    ...summary,
  };

  if (asJson) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(c.blue("\n── aios instincts distill ─────────────────────────────────"));
    console.log(
      `  project: ${projectId}  ·  new observations: ${fresh.length}  ·  groups: ${summary.processedGroups}`
    );
    if (dryRun) console.log(c.dim("  dry-run — no LLM calls, no files written"));
    else {
      console.log(
        `  written: ${summary.written}  ·  updated: ${summary.updated}  ·  dropped (<${CONFIDENCE_FLOOR}): ${summary.droppedLowConfidence}  ·  rejected: ${summary.rejected}`
      );
    }
    if (summary.warnings.length) {
      for (const w of summary.warnings) console.log(c.yellow(`  warning: ${w}`));
    }
  }
}

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";

export const SKILL_STAGES = new Set([
  "spec-author",
  "spec-eval",
  "spec-fix",
  "spec-publish",
  "builder",
  "review",
  "cleanup",
  "interactive",
  "export",
]);
export const SKILL_MUTABILITY = new Set(["read-only", "local-write", "external-write"]);

function fail(message) {
  throw new Error(`delivery skill suite: ${message}`);
}

export function normalizeSkillText(value) {
  return value.replace(/\r\n?/g, "\n");
}

export function skillSha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertPlainFileSegments(root, relativePath) {
  const pieces = relativePath.split("/");
  let cursor = root;
  for (const piece of pieces) {
    if (!piece || piece === "." || piece === "..") fail(`unsafe path segment in '${relativePath}'`);
    cursor = path.join(cursor, piece);
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink()) fail(`symlink is not allowed: ${path.relative(root, cursor)}`);
  }
}

function contained(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel !== "" && !rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel);
}

function parseCanonicalFrontmatter(text, id) {
  const match = text.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!match) fail(`${id}: SKILL.md must start with YAML frontmatter`);
  const values = {};
  for (const raw of match[1].split("\n")) {
    const field = raw.match(/^([a-z_]+):\s*(.+)$/);
    if (!field) fail(`${id}: frontmatter must use scalar name and description fields`);
    if (Object.hasOwn(values, field[1])) fail(`${id}: duplicate frontmatter field '${field[1]}'`);
    values[field[1]] = field[2].replace(/^(['"])(.*)\1$/, "$2").trim();
  }
  const keys = Object.keys(values).sort((left, right) => left.localeCompare(right, "en"));
  if (keys.join(",") !== "description,name")
    fail(`${id}: frontmatter may contain only name and description`);
  if (values.name !== id) fail(`${id}: frontmatter name '${values.name}' does not match id`);
  if (!values.description) fail(`${id}: description must not be empty`);
  return values;
}

function assertStringArray(value, field, id, { nonempty = false } = {}) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim()))
    fail(`${id}: ${field} must be an array of non-empty strings`);
  if (nonempty && value.length === 0) fail(`${id}: ${field} must not be empty`);
  if (new Set(value).size !== value.length) fail(`${id}: ${field} contains duplicates`);
}

function validateLimits(limits) {
  if (!limits || typeof limits !== "object") fail("limits object is required");
  const bounds = {
    compact_index_bytes: 1500,
    stage_skill_bytes: 6000,
    builder_total_bytes: 10000,
    builder_skill_count: 2,
  };
  for (const [field, maximum] of Object.entries(bounds)) {
    if (!Number.isInteger(limits[field]) || limits[field] < 1 || limits[field] > maximum)
      fail(`limits.${field} must be an integer between 1 and ${maximum}`);
  }
}

function validateEntry(entry) {
  if (!entry || typeof entry !== "object") fail("every skill entry must be an object");
  const id = entry.id;
  if (typeof id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id))
    fail(`invalid skill id '${id}'`);
  if (entry.path !== `${id}/SKILL.md`) fail(`${id}: path must be '${id}/SKILL.md'`);
  assertStringArray(entry.stages, "stages", id, { nonempty: true });
  if (entry.stages.some((stage) => !SKILL_STAGES.has(stage)))
    fail(`${id}: contains an unknown stage`);
  if (!SKILL_MUTABILITY.has(entry.mutability)) fail(`${id}: invalid mutability`);
  if (!Number.isInteger(entry.max_bytes) || entry.max_bytes < 1 || entry.max_bytes > 6000)
    fail(`${id}: max_bytes must be between 1 and 6000`);
  assertStringArray(entry.conflicts, "conflicts", id);
  assertStringArray(entry.prerequisites, "prerequisites", id);
  if (entry.conflicts.includes(id) || entry.prerequisites.includes(id))
    fail(`${id}: cannot conflict with or require itself`);
  if (typeof entry.explicit_invocation_required !== "boolean")
    fail(`${id}: explicit_invocation_required must be boolean`);
  if (!entry.routing || typeof entry.routing !== "object") fail(`${id}: routing is required`);
  assertStringArray(entry.routing.positive, "routing.positive", id, { nonempty: true });
  assertStringArray(entry.routing.negative, "routing.negative", id, { nonempty: true });
  if (entry.mutability === "external-write" && !entry.explicit_invocation_required)
    fail(`${id}: external-write skills must require explicit invocation`);
}

export function loadSkillSuite({
  repo = process.cwd(),
  manifestPath = path.join(repo, ".claude", "skill-suite.json"),
} = {}) {
  const repoReal = realpathSync(repo);
  const manifestReal = realpathSync(manifestPath);
  if (!contained(repoReal, manifestReal)) fail("manifest must be inside the repository");
  const manifest = JSON.parse(readFileSync(manifestReal, "utf8"));
  if (manifest.version !== 1) fail("version must be 1");
  validateLimits(manifest.limits);
  if (!Array.isArray(manifest.skills) || manifest.skills.length === 0)
    fail("skills must be a non-empty array");

  for (const entry of manifest.skills) validateEntry(entry);
  const ids = manifest.skills.map((entry) => entry.id);
  if (new Set(ids).size !== ids.length) fail("skill ids must be unique");
  const known = new Set(ids);
  const byId = new Map(manifest.skills.map((entry) => [entry.id, entry]));
  for (const entry of manifest.skills) {
    for (const related of [...entry.conflicts, ...entry.prerequisites]) {
      if (!known.has(related)) fail(`${entry.id}: unknown related skill '${related}'`);
    }
    for (const conflict of entry.conflicts) {
      if (!byId.get(conflict).conflicts.includes(entry.id))
        fail(`${entry.id}: conflict with '${conflict}' must be symmetric`);
    }
  }

  const skillsRoot = realpathSync(path.join(repoReal, ".claude", "skills"));
  const loaded = manifest.skills.map((entry) => {
    assertPlainFileSegments(skillsRoot, entry.path);
    const file = realpathSync(path.join(skillsRoot, entry.path));
    if (!contained(skillsRoot, file)) fail(`${entry.id}: path escapes .claude/skills`);
    const body = normalizeSkillText(readFileSync(file, "utf8"));
    const frontmatter = parseCanonicalFrontmatter(body, entry.id);
    const bytes = Buffer.byteLength(body, "utf8");
    if (bytes > entry.max_bytes || bytes > manifest.limits.stage_skill_bytes)
      fail(`${entry.id}: ${bytes} bytes exceeds its skill cap`);
    return {
      ...entry,
      description: frontmatter.description,
      file,
      body,
      bytes,
      sha256: skillSha256(body),
    };
  });
  return { ...manifest, repo: repoReal, manifestPath: manifestReal, skills: loaded };
}

export function parseDeclaredSkills(specText) {
  const normalized = normalizeSkillText(specText);
  const frontmatter = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)/)?.[1];
  if (!frontmatter) return [];
  const lines = frontmatter.split("\n");
  const skills = [];
  for (let index = 0; index < lines.length; index++) {
    const inline = lines[index].match(/^skills:\s*\[(.*)\]\s*$/);
    if (inline) {
      for (const id of inline[1]
        .split(",")
        .map((value) => value.trim().replace(/^['"]|['"]$/g, "")))
        if (id) skills.push(id);
      continue;
    }
    if (!/^skills:\s*$/.test(lines[index])) continue;
    while (index + 1 < lines.length) {
      const item = lines[index + 1].match(/^\s+-\s+([a-z0-9-]+)\s*$/);
      if (!item) break;
      skills.push(item[1]);
      index++;
    }
  }
  if (new Set(skills).size !== skills.length) fail("declared skills contain duplicates");
  return skills;
}

export function validateSkillSelection({
  suite,
  ids,
  stage,
  source = "spec",
  explicit = source !== "semantic",
}) {
  if (!Array.isArray(ids)) fail("selected skill ids must be an array");
  if (new Set(ids).size !== ids.length) fail("selected skill ids contain duplicates");
  if (stage === "builder" && ids.length > suite.limits.builder_skill_count)
    fail(`builder selection exceeds ${suite.limits.builder_skill_count} skills`);
  const byId = new Map(suite.skills.map((skill) => [skill.id, skill]));
  const selected = ids.map((id) => {
    const skill = byId.get(id);
    if (!skill) fail(`unknown skill '${id}'`);
    if (!skill.stages.includes(stage)) fail(`${id}: not allowed in stage '${stage}'`);
    if (skill.explicit_invocation_required && !explicit)
      fail(`${id}: explicit invocation is required`);
    return skill;
  });
  for (const skill of selected) {
    const conflict = skill.conflicts.find((id) => ids.includes(id));
    if (conflict) fail(`${skill.id}: conflicts with '${conflict}'`);
  }
  return selected;
}

export function loadSkillContext({
  repo = process.cwd(),
  ids,
  stage,
  source = "spec",
  explicit,
  manifestPath,
} = {}) {
  const suite = loadSkillSuite({ repo, manifestPath });
  const skills = validateSkillSelection({ suite, ids, stage, source, explicit });
  const bytes = skills.reduce((sum, skill) => sum + skill.bytes, 0);
  const cap =
    stage === "builder" ? suite.limits.builder_total_bytes : suite.limits.stage_skill_bytes;
  if (bytes > cap) fail(`selected skill context is ${bytes} bytes; cap is ${cap}`);
  return {
    source: ids.length ? source : "none",
    stage,
    bytes,
    skills,
    prompt: skills.map((skill) => skill.body).join("\n\n"),
    audit: skills.map(({ id, sha256, bytes: skillBytes }) => ({
      id,
      sha256,
      bytes: skillBytes,
    })),
  };
}

export function compactSkillIndex({ repo = process.cwd(), manifestPath } = {}) {
  const suite = loadSkillSuite({ repo, manifestPath });
  const index = [
    "AIOs focused skills: select full bodies only after matching the current stage.",
    ...suite.skills.map(
      (skill) =>
        `${skill.id}|${skill.mutability}|${skill.explicit_invocation_required ? "explicit" : "auto"}`
    ),
  ].join("\n");
  const bytes = Buffer.byteLength(index, "utf8");
  if (bytes > suite.limits.compact_index_bytes)
    fail(`compact index is ${bytes} bytes; cap is ${suite.limits.compact_index_bytes}`);
  return { text: index, bytes, sha256: skillSha256(index) };
}

export function loadSkillSuiteIndex(repo) {
  const manifestPath = path.join(repo, ".claude", "skill-suite.json");
  return existsSync(manifestPath)
    ? new Map(loadSkillSuite({ repo }).skills.map((skill) => [skill.id, skill]))
    : new Map();
}

export function skillSuiteExportFields(skill, fallbackTriggers) {
  return {
    triggers: skill?.routing.positive ?? (Array.isArray(fallbackTriggers) ? fallbackTriggers : []),
    suite: skill ?? null,
  };
}

export function selectSkillsForExport(skills, only) {
  return only
    ? skills.filter((skill) => skill.name === only)
    : skills.filter((skill) => skill.suite?.mutability !== "external-write");
}

export function writeSkillExportRouting(outDir, skill, description, native) {
  writeFileSync(
    path.join(outDir, "aios-routing.json"),
    `${JSON.stringify(
      {
        id: skill.id,
        description,
        trigger_literals: skill.routing.positive,
        exclusion_literals: skill.routing.negative,
        mutability: skill.mutability,
        stages: skill.stages,
        explicit_invocation_required: skill.explicit_invocation_required,
        body_sha256: skill.sha256,
        body_bytes: skill.bytes,
        degradation: native
          ? "native skill body with generated routing metadata"
          : "runtime-specific static instructions; deterministic workflow selection remains in aios",
      },
      null,
      2
    )}\n`
  );
}

export function writeSkillExportRoutings(skills, outBase, native) {
  for (const skill of skills) {
    if (skill.suite)
      writeSkillExportRouting(
        path.join(outBase, skill.name),
        skill.suite,
        skill.description,
        native
      );
  }
}

export function routeSkillPrompt({ suite, prompt, stage = "interactive", explicit = false }) {
  const normalized = prompt.toLowerCase();
  const explicitId = suite.skills.find((skill) =>
    new RegExp(`(?:\\$|/)${skill.id}(?:\\b|$)`, "i").test(prompt)
  );
  if (explicitId) {
    return validateSkillSelection({
      suite,
      ids: [explicitId.id],
      stage,
      source: "explicit",
      explicit: true,
    })[0];
  }
  const matches = suite.skills.filter((skill) => {
    if (!skill.stages.includes(stage) || skill.explicit_invocation_required || explicit)
      return false;
    if (skill.routing.negative.some((phrase) => normalized.includes(phrase.toLowerCase())))
      return false;
    return skill.routing.positive.some((phrase) => normalized.includes(phrase.toLowerCase()));
  });
  return matches.length === 1 ? matches[0] : null;
}

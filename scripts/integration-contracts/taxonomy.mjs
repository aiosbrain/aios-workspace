/**
 * Taxonomy, invariant-ownership, and schema-hygiene checks (AIO-835 Phase 0).
 *
 * These prove the contract artifacts are internally consistent BEFORE any adapter is
 * written against them: a capability that references a test id nobody defines, or an
 * invariant with two owners, is a defect in the constitution itself, not in a connector.
 */
import { CONTRACT_VERSION } from "./load.mjs";

const CLOSED_CAPABILITY_RE = /^(?:core|pm)\.[a-z0-9_]+\.[a-z0-9_]+$/;
const INVARIANT_ID_RE = /^INT-(\d{3})$/;

/** Recursively collect every key path where a `format` keyword appears. */
function findFormatKeywords(node, pointer = "") {
  const hits = [];
  if (Array.isArray(node)) {
    node.forEach((item, i) => hits.push(...findFormatKeywords(item, `${pointer}/${i}`)));
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "format" && typeof value === "string") hits.push(`${pointer}/format`);
      hits.push(...findFormatKeywords(value, `${pointer}/${key}`));
    }
  }
  return hits;
}

export function checkContractVersions(artifacts, fail) {
  for (const [file, doc] of Object.entries(artifacts)) {
    const declared = doc.contract_version;
    if (declared === undefined) {
      // The three JSON Schemas carry their version in $id + the taxonomy; only the three
      // data artifacts declare contract_version directly.
      if (!file.endsWith(".schema.json")) fail(`${file}: missing contract_version`);
      continue;
    }
    if (declared !== CONTRACT_VERSION) {
      fail(`${file}: contract_version is ${declared}, expected ${CONTRACT_VERSION}`);
    }
  }
}

export function checkSchemaHygiene(artifacts, fail) {
  for (const file of ["manifest.schema.json", "outcomes.schema.json", "evidence.schema.json"]) {
    const schema = artifacts[file];
    if (schema.$schema !== "https://json-schema.org/draft/2020-12/schema") {
      fail(`${file}: $schema must be JSON Schema Draft 2020-12`);
    }
    if (typeof schema.$id !== "string" || !schema.$id.startsWith("https://")) {
      fail(`${file}: $id must be a stable https identifier`);
    }
    const formats = findFormatKeywords(schema);
    if (formats.length > 0) {
      // The repo pins lexical constraints with `pattern` so plain ajv (no ajv-formats) is a
      // faithful compile of the contract. A stray `format` would be silently ignored.
      fail(`${file}: uses format keyword(s) at ${formats.join(", ")} — pin with pattern instead`);
    }
  }
}

export function checkTaxonomy(capabilities, fail) {
  const { profiles, capabilities: caps, tests, suites, dependency_rules: rules } = capabilities;

  for (const [id, cap] of Object.entries(caps)) {
    if (!CLOSED_CAPABILITY_RE.test(id)) {
      fail(`capabilities: "${id}" is not a valid closed v1 capability id`);
    }
    if (!profiles[cap.profile]) {
      fail(`capabilities: "${id}" declares unknown profile "${cap.profile}"`);
    } else if (!profiles[cap.profile].capabilities.includes(id)) {
      fail(`capabilities: "${id}" is not listed in profile "${cap.profile}"`);
    }
    if (!capabilities.capability_classes[cap.class]) {
      fail(`capabilities: "${id}" declares unknown class "${cap.class}"`);
    }
    if (!Array.isArray(cap.tests) || cap.tests.length === 0) {
      fail(`capabilities: "${id}" declares no canonical test id`);
    }
    for (const testId of cap.tests ?? []) {
      if (!tests[testId]) fail(`capabilities: "${id}" references unknown test "${testId}"`);
    }
  }

  for (const [profileId, profile] of Object.entries(profiles)) {
    for (const id of profile.capabilities) {
      if (!caps[id]) fail(`profiles: "${profileId}" lists unknown capability "${id}"`);
    }
  }

  for (const [testId, test] of Object.entries(tests)) {
    if (!suites[test.suite]) fail(`tests: "${testId}" references unknown suite "${test.suite}"`);
  }

  // always_required must agree in both places it is stated.
  const flagged = Object.entries(caps)
    .filter(([, cap]) => cap.always_required === true)
    .map(([id]) => id)
    .sort();
  const listed = [...rules.always_required].sort();
  if (canonicalList(flagged) !== canonicalList(listed)) {
    fail(
      `dependency_rules.always_required [${listed}] disagrees with the always_required capability flags [${flagged}]`
    );
  }

  checkDependencyRules(caps, rules, fail);
  checkLifecycleMapping(caps, fail);
  checkPmMutationRule(caps, rules, fail);
}

function canonicalList(list) {
  return list.join("|");
}

function checkDependencyRules(caps, rules, fail) {
  for (const group of ["requires_all", "requires_any"]) {
    for (const [capId, required] of Object.entries(rules[group])) {
      if (!caps[capId]) fail(`dependency_rules.${group}: unknown capability "${capId}"`);
      for (const dep of required) {
        if (!caps[dep]) {
          fail(`dependency_rules.${group}["${capId}"]: unknown dependency "${dep}"`);
        }
      }
    }
  }
  for (const [capId, pointers] of Object.entries(rules.requires_manifest)) {
    if (!caps[capId]) fail(`dependency_rules.requires_manifest: unknown capability "${capId}"`);
    for (const pointer of pointers) {
      if (!pointer.startsWith("/")) {
        fail(`dependency_rules.requires_manifest["${capId}"]: "${pointer}" is not a JSON Pointer`);
      }
    }
  }
}

function checkLifecycleMapping(caps, fail) {
  const seen = new Map();
  for (const [id, cap] of Object.entries(caps)) {
    if (!cap.lifecycle_operation) continue;
    if (seen.has(cap.lifecycle_operation)) {
      fail(
        `capabilities: lifecycle operation "${cap.lifecycle_operation}" is claimed by both "${seen.get(cap.lifecycle_operation)}" and "${id}"`
      );
    }
    seen.set(cap.lifecycle_operation, id);
  }
}

/**
 * "Every PM mutation requires pm.work_item.read" is stated in prose in the specification.
 * This proves the machine-readable rules actually encode it, so a future capability added
 * without its read dependency cannot slip through.
 */
function checkPmMutationRule(caps, rules, fail) {
  for (const [id, cap] of Object.entries(caps)) {
    if (cap.profile !== "pm") continue;
    if (cap.class !== "write" && cap.class !== "destructive") continue;
    const requires = rules.requires_all[id] ?? [];
    if (!requires.includes("pm.work_item.read")) {
      fail(`dependency_rules.requires_all: PM mutation "${id}" does not require pm.work_item.read`);
    }
  }
}

export function checkInvariants(invariantsDoc, capabilities, fail) {
  const entries = Object.entries(invariantsDoc.invariants);
  const ids = entries.map(([id]) => id);

  const numbers = ids.map((id) => {
    const match = INVARIANT_ID_RE.exec(id);
    if (!match) fail(`invariants: "${id}" is not a valid INT-nnn id`);
    return match ? Number(match[1]) : NaN;
  });
  const sorted = [...numbers].sort((a, b) => a - b);
  sorted.forEach((n, i) => {
    if (n !== i + 1)
      fail(
        `invariants: id sequence is not contiguous from INT-001 (saw ${n} at position ${i + 1})`
      );
  });

  const owners = new Map();
  for (const [id, invariant] of entries) {
    const owner = invariant.owning_test;
    const test = capabilities.tests[owner];
    if (!test) {
      fail(`invariants: ${id} owning_test "${owner}" is not in the test registry`);
      continue;
    }
    if (owners.has(owner)) {
      fail(
        `invariants: test "${owner}" owns both ${owners.get(owner)} and ${id} — one owner per test`
      );
    }
    owners.set(owner, id);

    const liveOnly = capabilities.suites[test.suite].live_only === true;
    if (invariant.evidence === "live" && !liveOnly) {
      fail(
        `invariants: ${id} claims live evidence but "${owner}" is in non-live suite "${test.suite}"`
      );
    }
    if (invariant.evidence === "automated" && liveOnly) {
      fail(
        `invariants: ${id} claims automated evidence but "${owner}" is in live-only suite "${test.suite}"`
      );
    }
  }
}

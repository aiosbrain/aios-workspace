/**
 * Normative manifest rules that JSON Schema cannot express (AIO-835 Phase 0).
 *
 * These are not "extra lint" — they are the parts of the canonical-manifest section of the
 * specification that are inherently cross-field: capability/test correspondence, the
 * exhaustive profile partition, dependency satisfaction, when a mutation/pagination/webhook
 * block becomes mandatory, private-address rejection, and the extension byte budget.
 *
 * Every rule has a stable id so a negative fixture can name the exact rule it is expected to
 * trip. A fixture that fails for a DIFFERENT reason than it claims is itself a failure — that
 * is what stops a negative fixture from rotting into a tautology.
 */
import { canonicalJson, resolvePointer } from "./load.mjs";

const EXTENSION_RE = /^x-[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9._-]*$/;
const EXTENSION_MAX_BYTES = 16 * 1024;

export const MANIFEST_RULE_IDS = [
  "MR-CAPABILITY-UNKNOWN",
  "MR-EXTENSION-UNSUPPORTED-LIST",
  "MR-PROFILE-PARTITION",
  "MR-ALWAYS-REQUIRED-MISSING",
  "MR-ALWAYS-REQUIRED-UNSUPPORTED",
  "MR-DEPENDENCY-MISSING",
  "MR-DEPENDENCY-ANY-MISSING",
  "MR-MANIFEST-REQUIREMENT",
  "MR-TEST-CORRESPONDENCE",
  "MR-BASELINE-TEST",
  "MR-CONDITIONAL-TEST",
  "MR-SUITE-COVERAGE",
  "MR-SUITE-UNKNOWN",
  "MR-TEST-UNKNOWN",
  "MR-LIFECYCLE-CAPABILITY",
  "MR-MUTATION-REQUIRED",
  "MR-MUTATION-CLASS-MISMATCH",
  "MR-PAGINATION-REQUIRED",
  "MR-RATE-LIMIT-REQUIRED",
  "MR-INBOUND-EVENTS",
  "MR-SYNC-DIRECTION",
  "MR-HOST-PRIVATE",
  "MR-EXTENSION-SIZE",
  "MR-MIN-CONTRACT-VERSION",
];

/**
 * Reject loopback, private, link-local, carrier-grade-NAT, multicast, reserved and
 * unspecified IPv4 targets, plus single-label and `.local`/`.localhost` names. The manifest
 * schema's origin pattern already rules out userinfo, paths, wildcards and bare `localhost`;
 * this covers the address ranges a pattern cannot reason about. IPv6 literals require
 * brackets, which the origin pattern rejects outright.
 */
export function isPrivateHost(hostname) {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;

  const octets = host.split(".");
  if (octets.length !== 4 || !octets.every((o) => /^\d{1,3}$/.test(o))) return false;
  const [a, b] = octets.map(Number);
  if (octets.map(Number).some((o) => o > 255)) return true;
  if (a === 0 || a === 127) return true; // unspecified, loopback
  if (a === 10) return true; // RFC 1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918
  if (a === 192 && b === 168) return true; // RFC 1918
  if (a === 169 && b === 254) return true; // link-local
  if (a === 100 && b >= 64 && b <= 127) return true; // RFC 6598 CGNAT
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function parseSemver(value) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(value ?? "");
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compareSemver(left, right) {
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Evaluate every cross-field rule. Returns `[]` for a conformant manifest, otherwise one
 * entry per violation. Assumes the manifest already validated against manifest.schema.json.
 */
export function evaluateManifest(manifest, contract) {
  const findings = [];
  const add = (rule, message) => findings.push({ rule, message });

  const caps = contract.capabilities;
  const supported = manifest.capabilities.supported;
  const unsupported = manifest.capabilities.unsupported.map((entry) => entry.capability);
  const supportedSet = new Set(supported);

  checkCapabilityIds(manifest, caps, add);
  checkProfilePartition(manifest, contract, supported, unsupported, add);
  checkDependencies(manifest, contract, supportedSet, add);
  checkConformanceCorrespondence(manifest, contract, supported, add);
  checkLifecycle(manifest, caps, supportedSet, add);
  checkMutationBlock(manifest, caps, supported, add);
  checkPaginationAndRateLimit(manifest, caps, supported, add);
  checkSyncAndEvents(manifest, supportedSet, add);
  checkHosts(manifest, add);
  checkExtensions(manifest, add);
  checkMinContractVersion(manifest, add);

  return findings;
}

function checkCapabilityIds(manifest, caps, add) {
  const all = [
    ...manifest.capabilities.supported,
    ...manifest.capabilities.unsupported.map((e) => e.capability),
  ];
  for (const id of all) {
    if (caps[id]) continue;
    if (EXTENSION_RE.test(id)) continue;
    add(
      "MR-CAPABILITY-UNKNOWN",
      `capability "${id}" is outside the closed v1 set and is not namespaced`
    );
  }
  for (const entry of manifest.capabilities.unsupported) {
    if (!caps[entry.capability] && EXTENSION_RE.test(entry.capability)) {
      add(
        "MR-EXTENSION-UNSUPPORTED-LIST",
        `extension capability "${entry.capability}" cannot appear in the unsupported list — extensions are not profile members`
      );
    }
  }
}

function checkProfilePartition(manifest, contract, supported, unsupported, add) {
  const declared = new Set([...supported, ...unsupported]);
  const both = supported.filter((id) => unsupported.includes(id));
  for (const id of both) {
    add("MR-PROFILE-PARTITION", `capability "${id}" appears in both supported and unsupported`);
  }

  for (const profileId of manifest.profiles) {
    const profile = contract.profiles[profileId];
    if (!profile) continue;
    for (const id of profile.capabilities) {
      if (!declared.has(id)) {
        add(
          "MR-PROFILE-PARTITION",
          `profile "${profileId}" capability "${id}" is in neither supported nor unsupported — omission is invalid`
        );
      }
    }
  }

  for (const id of contract.dependency_rules.always_required) {
    if (unsupported.includes(id)) {
      add(
        "MR-ALWAYS-REQUIRED-UNSUPPORTED",
        `"${id}" is always required and may never be unsupported`
      );
    } else if (!supported.includes(id)) {
      add("MR-ALWAYS-REQUIRED-MISSING", `"${id}" is always required but is not supported`);
    }
  }
}

function checkDependencies(manifest, contract, supportedSet, add) {
  const rules = contract.dependency_rules;
  for (const [capId, required] of Object.entries(rules.requires_all)) {
    if (!supportedSet.has(capId)) continue;
    for (const dep of required) {
      if (!supportedSet.has(dep)) {
        add("MR-DEPENDENCY-MISSING", `"${capId}" requires "${dep}", which is not supported`);
      }
    }
  }
  for (const [capId, anyOf] of Object.entries(rules.requires_any)) {
    if (!supportedSet.has(capId)) continue;
    if (!anyOf.some((dep) => supportedSet.has(dep))) {
      add("MR-DEPENDENCY-ANY-MISSING", `"${capId}" requires at least one of [${anyOf.join(", ")}]`);
    }
  }
  for (const [capId, pointers] of Object.entries(rules.requires_manifest)) {
    if (!supportedSet.has(capId)) continue;
    for (const pointer of pointers) {
      const value = resolvePointer(manifest, pointer);
      const satisfied = Array.isArray(value) ? value.length > 0 : value === true;
      if (!satisfied) {
        add(
          "MR-MANIFEST-REQUIREMENT",
          `"${capId}" requires manifest ${pointer} to be true or non-empty`
        );
      }
    }
  }
}

function checkConformanceCorrespondence(manifest, contract, supported, add) {
  const declaredTests = new Set(manifest.conformance.tests);
  for (const id of supported) {
    const cap = contract.capabilities[id];
    if (!cap) continue; // extension capability: no canonical test
    for (const testId of cap.tests) {
      if (!declaredTests.has(testId)) {
        add(
          "MR-TEST-CORRESPONDENCE",
          `supported capability "${id}" requires canonical test "${testId}" in conformance.tests`
        );
      }
    }
  }
  for (const testId of contract.baseline_tests) {
    if (!declaredTests.has(testId)) {
      add("MR-BASELINE-TEST", `every connector must declare baseline test "${testId}"`);
    }
  }
  for (const [testId, condition] of Object.entries(contract.conditional_tests)) {
    const required = conditionHolds(condition, manifest);
    if (required === null) {
      add(
        "MR-CONDITIONAL-TEST",
        `unknown conditional-test condition "${condition}" for "${testId}"`
      );
    } else if (required && !declaredTests.has(testId)) {
      add("MR-CONDITIONAL-TEST", `condition "${condition}" holds, so test "${testId}" is required`);
    }
  }

  for (const testId of manifest.conformance.tests) {
    if (!contract.tests[testId]) {
      add("MR-TEST-UNKNOWN", `conformance.tests references unknown test "${testId}"`);
    }
  }
  for (const suiteId of manifest.conformance.suites) {
    if (!contract.suites[suiteId]) {
      add("MR-SUITE-UNKNOWN", `conformance.suites references unknown suite "${suiteId}"`);
    }
  }

  // All eight non-live suites run against every connector, so every one must be listed.
  const declaredSuites = new Set(manifest.conformance.suites);
  for (const [suiteId, suite] of Object.entries(contract.suites)) {
    if (suite.live_only === true) continue;
    if (!declaredSuites.has(suiteId)) {
      add("MR-SUITE-COVERAGE", `conformance.suites omits required suite "${suiteId}"`);
    }
  }
}

/** Closed set of conditional-test predicates. Returns null for an unrecognized name. */
function conditionHolds(condition, manifest) {
  switch (condition) {
    case "oauth_or_webhook":
      return manifest.auth.mode === "oauth" || manifest.events?.mode === "webhook";
    case "pagination_declared":
      return Boolean(manifest.pagination);
    case "rate_limit_declared":
      return Boolean(manifest.rate_limit);
    default:
      return null;
  }
}

function checkLifecycle(manifest, caps, supportedSet, add) {
  for (const [capId, cap] of Object.entries(caps)) {
    if (!cap.lifecycle_operation) continue;
    const present = Object.prototype.hasOwnProperty.call(
      manifest.lifecycle,
      cap.lifecycle_operation
    );
    const declared = supportedSet.has(capId);
    if (present && !declared) {
      add(
        "MR-LIFECYCLE-CAPABILITY",
        `lifecycle.${cap.lifecycle_operation} is defined but "${capId}" is not supported`
      );
    }
    if (declared && !present) {
      add(
        "MR-LIFECYCLE-CAPABILITY",
        `"${capId}" is supported but lifecycle.${cap.lifecycle_operation} is not defined`
      );
    }
  }
}

function mutationClassesOf(caps, supported) {
  const classes = new Set();
  for (const id of supported) {
    const cls = caps[id]?.class;
    if (cls === "write" || cls === "destructive") classes.add(cls);
  }
  return classes;
}

function checkMutationBlock(manifest, caps, supported, add) {
  const classes = mutationClassesOf(caps, supported);
  if (classes.size === 0) return;
  if (!manifest.mutation) {
    add(
      "MR-MUTATION-REQUIRED",
      `mutation capabilities are declared (${[...classes].join(", ")}) but the manifest has no mutation block`
    );
    return;
  }
  const declared = new Set(manifest.mutation.classes);
  for (const cls of classes) {
    if (!declared.has(cls)) {
      add(
        "MR-MUTATION-CLASS-MISMATCH",
        `mutation.classes omits "${cls}", which supported capabilities require`
      );
    }
  }
  for (const cls of declared) {
    if (!classes.has(cls)) {
      add(
        "MR-MUTATION-CLASS-MISMATCH",
        `mutation.classes declares "${cls}" but no supported capability has that class`
      );
    }
  }
}

function checkPaginationAndRateLimit(manifest, caps, supported, add) {
  const paginated = supported.filter((id) => caps[id]?.paginated === true);
  if (paginated.length > 0 && !manifest.pagination) {
    add(
      "MR-PAGINATION-REQUIRED",
      `pagination-capable reads are declared (${paginated.join(", ")}) but the manifest has no pagination block`
    );
  }
  if ((manifest.transport === "http" || manifest.transport === "graphql") && !manifest.rate_limit) {
    add("MR-RATE-LIMIT-REQUIRED", `transport "${manifest.transport}" requires a rate_limit block`);
  }
}

function checkSyncAndEvents(manifest, supportedSet, add) {
  const outbound = supportedSet.has("pm.sync.outbound");
  const inbound = supportedSet.has("pm.sync.inbound");
  const expected =
    inbound && outbound ? "bidirectional" : outbound ? "outbound" : inbound ? "inbound" : "none";
  if (manifest.sync.direction !== expected) {
    add(
      "MR-SYNC-DIRECTION",
      `sync.direction is "${manifest.sync.direction}" but the declared sync capabilities imply "${expected}"`
    );
  }
  if (inbound && (manifest.events?.mode ?? "none") === "none") {
    add(
      "MR-INBOUND-EVENTS",
      `pm.sync.inbound is supported but events.mode is "none" — inbound sync needs webhook or polling delivery`
    );
  }
}

function checkHosts(manifest, add) {
  for (const origin of manifest.provider_hosts) {
    const hostname = origin.slice("https://".length).split(":")[0];
    if (isPrivateHost(hostname)) {
      add(
        "MR-HOST-PRIVATE",
        `provider host "${origin}" resolves to a localhost or private-address target`
      );
    }
  }
}

function checkExtensions(manifest, add) {
  for (const [key, value] of Object.entries(manifest.extensions ?? {})) {
    const bytes = Buffer.byteLength(canonicalJson(value), "utf8");
    if (bytes > EXTENSION_MAX_BYTES) {
      add(
        "MR-EXTENSION-SIZE",
        `extension "${key}" is ${bytes} bytes, over the ${EXTENSION_MAX_BYTES}-byte budget`
      );
    }
  }
}

function checkMinContractVersion(manifest, add) {
  const declared = parseSemver(manifest.contract_version);
  const min = parseSemver(manifest.conformance.min_contract_version);
  if (!declared || !min) return;
  if (compareSemver(min, declared) > 0) {
    add(
      "MR-MIN-CONTRACT-VERSION",
      `conformance.min_contract_version ${manifest.conformance.min_contract_version} exceeds contract_version ${manifest.contract_version}`
    );
  }
}

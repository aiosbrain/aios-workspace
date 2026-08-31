import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { COMMANDS } from "../scripts/cli/registry.mjs";
import { DEVTOOLS_COMMANDS } from "../scripts/cli/devtools-commands.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INVENTORY_PATH = path.join(ROOT, "docs", "architecture", "cli-command-inventory.v1.json");
const ADR_PATH = path.join(ROOT, "docs", "adr", "0002-single-binary-cli-platform.md");
const PACKAGE_PATH = path.join(ROOT, "package.json");
const DISPATCH_PATH = path.join(ROOT, "scripts", "cli", "dispatch.mjs");
const CI_PATH = path.join(ROOT, ".github", "workflows", "ci.yml");
const REGISTRY_PATH = path.join(ROOT, "scripts", "cli", "registry.mjs");
const DEVTOOLS_COMMANDS_PATH = path.join(ROOT, "scripts", "cli", "devtools-commands.mjs");
const DEVTOOLS_DISPATCH_PATH = path.join(ROOT, "scripts", "devtools-dispatch.mjs");
const SHELL_INSTALL_PATH = path.join(ROOT, "scripts", "install-aios-shell.sh");

const inventoryText = readFileSync(INVENTORY_PATH, "utf8");
const inventory = JSON.parse(inventoryText);
const packageJson = JSON.parse(readFileSync(PACKAGE_PATH, "utf8"));
const adr = readFileSync(ADR_PATH, "utf8");
const dispatchSource = readFileSync(DISPATCH_PATH, "utf8");
const ciSource = readFileSync(CI_PATH, "utf8");
const registrySource = readFileSync(REGISTRY_PATH, "utf8");
const devtoolsCommandsSource = readFileSync(DEVTOOLS_COMMANDS_PATH, "utf8");
const devtoolsDispatchSource = readFileSync(DEVTOOLS_DISPATCH_PATH, "utf8");
const shellInstallSource = readFileSync(SHELL_INSTALL_PATH, "utf8");

const sorted = (values) => [...values].sort((a, b) => a.localeCompare(b, "en"));

function walkFiles(relativeRoot) {
  const found = [];
  const visit = (relativeDirectory) => {
    for (const entry of readdirSync(path.join(ROOT, relativeDirectory), { withFileTypes: true })) {
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) visit(relativePath);
      else if (entry.isFile()) found.push(relativePath);
    }
  };
  visit(relativeRoot);
  return found;
}

test("CLI architecture: every published bin is inventoried exactly once", () => {
  const published = inventory.routes.filter((route) => route.kind === "published-bin");
  assert.deepEqual(
    sorted(published.map((route) => route.bin)),
    sorted(Object.keys(packageJson.bin))
  );
  assert.equal(new Set(published.map((route) => route.bin)).size, published.length);

  for (const [bin, target] of Object.entries(packageJson.bin)) {
    const route = published.find((candidate) => candidate.bin === bin);
    assert.ok(route, `missing inventory route for published bin '${bin}'`);
    assert.ok(
      route.evidence.includes("package.json") || route.evidence.includes(`package.json#bin.${bin}`)
    );
    assert.ok(
      route.evidence.some((item) => item === target || item.endsWith(target)),
      `${bin} evidence must name its published target ${target}`
    );
  }
});

test("CLI architecture: every registered top-level command is inventoried exactly once", () => {
  const registered = inventory.routes.filter(
    (route) => route.registryCommand && route.status === "current"
  );
  assert.deepEqual(
    sorted(registered.map((route) => route.registryCommand)),
    sorted(COMMANDS.map((command) => command.name))
  );
  assert.equal(new Set(registered.map((route) => route.registryCommand)).size, registered.length);
  for (const route of registered) {
    assert.equal(
      route.route,
      `aios ${route.registryCommand}`,
      `${route.id}: canonical route drift`
    );
  }
});

test("CLI architecture: diagnostics are ordinary cold registry descriptors", () => {
  const currentDiagnostics = inventory.routes.filter(
    (route) => route.kind === "diagnostic-command" && route.status === "current"
  );
  assert.deepEqual(sorted(currentDiagnostics.map((route) => route.route)), [
    "aios doctor",
    "aios help",
    "aios provenance",
    "aios version",
  ]);
  assert.ok(
    currentDiagnostics.every((route) => route.source === "scripts/cli/diagnostic-commands.mjs")
  );
  assert.doesNotMatch(dispatchSource, /HELP_TOKENS|VERSION_TOKENS/);
  for (const route of currentDiagnostics) {
    const descriptor = COMMANDS.find((command) => command.name === route.registryCommand);
    assert.ok(descriptor, route.id);
    assert.deepEqual(descriptor.metadata, route.metadata, `${route.id}: cold metadata drift`);
  }
});

test("CLI architecture: every runtime descriptor exactly matches inventory cold metadata", () => {
  for (const descriptor of COMMANDS) {
    const route = inventory.routes.find(
      (candidate) => candidate.registryCommand === descriptor.name && candidate.status === "current"
    );
    assert.ok(route, `${descriptor.name}: missing current inventory route`);
    assert.deepEqual(descriptor.metadata, route.metadata, `${descriptor.name}: metadata drift`);
  }
});

test("CLI architecture: every executable in a declared non-registry seam is inventoried", () => {
  const discovered = inventory.executableSeamRoots
    .flatMap(walkFiles)
    .filter((relativePath) => readFileSync(path.join(ROOT, relativePath), "utf8").startsWith("#!"));
  const inventoryPaths = new Set(
    inventory.routes
      .flatMap((route) => [route.source, ...route.evidence])
      .flatMap((reference) => {
        if (reference.startsWith("@aiosbrain/")) return [];
        return [reference.split("#", 1)[0]];
      })
  );
  for (const executable of discovered) {
    assert.ok(inventoryPaths.has(executable), `un-inventoried executable seam: ${executable}`);
  }

  assert.match(shellInstallSource, /^aios\(\) \{/m, "shell installer must still define aios() ");
  const shellRoute = inventory.routes.find(
    (route) => route.id === "entrypoint.shell-function-aios"
  );
  assert.equal(shellRoute?.source, "scripts/install-aios-shell.sh");
});

test("CLI architecture: every route has one valid future owner, disposition, and metadata", () => {
  const configValues = new Set(["none", "optional", "user", "workspace", "user-or-workspace"]);
  const credentialValues = new Set(["none", "optional", "brain", "provider", "brain-or-provider"]);
  const networkValues = new Set(["never", "optional", "required"]);
  const outputValues = new Set(["human", "human-or-json", "protocol"]);
  const startupValues = new Set(["diagnostic", "pre-config", "offline", "requires-workspace"]);

  assert.equal(inventory.schemaVersion, 1);
  assert.equal(inventory.status, "accepted");
  assert.deepEqual(inventory.allowedDispositions, ["keep", "delegate", "migrate", "delete"]);
  assert.equal(new Set(inventory.routes.map((route) => route.id)).size, inventory.routes.length);

  for (const route of inventory.routes) {
    assert.equal(typeof route.futureOwner, "string", `${route.id}: futureOwner must be singular`);
    assert.ok(
      inventory.owners[route.futureOwner],
      `${route.id}: unknown owner ${route.futureOwner}`
    );
    assert.ok(
      inventory.allowedDispositions.includes(route.disposition),
      `${route.id}: invalid disposition ${route.disposition}`
    );
    assert.equal(route.metadata?.owner, route.futureOwner, `${route.id}: metadata owner drift`);
    assert.ok(configValues.has(route.metadata?.configurationRequirement), `${route.id}: config`);
    assert.ok(
      credentialValues.has(route.metadata?.credentialRequirement),
      `${route.id}: credential`
    );
    assert.ok(networkValues.has(route.metadata?.networkBehavior), `${route.id}: network`);
    assert.ok(outputValues.has(route.metadata?.outputMode), `${route.id}: output`);
    assert.ok(startupValues.has(route.metadata?.startupPolicy), `${route.id}: startup`);
    assert.equal(typeof route.metadata?.implementation?.module, "string", `${route.id}: module`);
    assert.equal(typeof route.metadata?.implementation?.lazy, "boolean", `${route.id}: lazy flag`);
    if (route.futureOwner.startsWith("adapter.")) {
      assert.equal(route.metadata.implementation.lazy, true, `${route.id}: adapters must be lazy`);
    }
    assert.match(route.releaseBoundary, /^v\d+\.\d+\.\d+$/, `${route.id}: release boundary`);
    assert.ok(Array.isArray(route.evidence) && route.evidence.length > 0, `${route.id}: evidence`);
  }
});

test("CLI architecture: compatibility routes are decision-complete", () => {
  const compatibility = inventory.routes.filter((route) => route.disposition !== "keep");
  assert.ok(compatibility.length > 0);
  for (const route of compatibility) {
    assert.ok(route.replacement?.trim(), `${route.id}: replacement`);
    assert.ok(route.removalBoundary?.trim(), `${route.id}: removal boundary`);
    assert.ok(route.rollback?.trim(), `${route.id}: rollback`);
    assert.ok(route.evidence.length > 0, `${route.id}: evidence`);
  }

  for (const bin of ["linear", "slack"]) {
    const route = inventory.routes.find((candidate) => candidate.id === `bin.npm.${bin}`);
    assert.equal(route?.disposition, "delegate");
    assert.equal(route?.replacement, `aios ${bin} …`);
    assert.equal(route?.removalBoundary, "v3.0.0-earliest");
  }
});

test("CLI architecture: aios is canonical and connector implementations are lazy", () => {
  assert.equal(inventory.canonicalExecutable, "aios");
  assert.deepEqual(inventory.canonicalConnectorRoutes, {
    linear: "aios linear",
    slack: "aios slack",
  });

  // linear shipped in AIO-1067 (CLI-RESET-3); slack lands with CLI-RESET-4.
  const expectedStatus = { linear: "current", slack: "planned-v2" };
  for (const connector of ["linear", "slack"]) {
    const route = inventory.routes.find(
      (candidate) => candidate.id === `command.aios.${connector}`
    );
    assert.equal(route?.route, `aios ${connector}`);
    assert.equal(route?.status, expectedStatus[connector]);
    assert.equal(route?.futureOwner, `adapter.${connector}`);
    assert.equal(route?.metadata?.implementation?.lazy, true);
  }
});

test("CLI architecture: adapter runtime modules load only at point of use", () => {
  for (const source of [registrySource, dispatchSource, devtoolsCommandsSource]) {
    assert.doesNotMatch(source, /from ["']@aiosbrain\/aios-devtools/);
    assert.doesNotMatch(source, /import ["']@aiosbrain\/aios-devtools/);
  }
  assert.match(devtoolsDispatchSource, /await import\(resolved\.specifier\)/);
  for (const [name, descriptor] of Object.entries(DEVTOOLS_COMMANDS)) {
    assert.match(String(descriptor.loader), /loadDevtoolsModule/, `${name}: eager devtools loader`);
  }
});

test("CLI architecture: diagnostics require no config, credentials, network, or connectors", () => {
  for (const name of ["help", "version", "doctor", "provenance"]) {
    const route = inventory.routes.find((candidate) => candidate.id === `command.aios.${name}`);
    assert.ok(route, `missing diagnostic ${name}`);
    assert.equal(route.metadata.startupPolicy, "diagnostic", name);
    assert.equal(route.metadata.configurationRequirement, "none", name);
    assert.equal(route.metadata.credentialRequirement, "none", name);
    assert.equal(route.metadata.networkBehavior, "never", name);
    assert.equal(route.futureOwner, "core.cli", name);
    assert.ok(!route.metadata.implementation.module.includes("connectors/"), name);
  }
});

test("CLI architecture: required route families and pinned seams cannot disappear", () => {
  const requiredIds = [
    "bin.devtools.aios-devtools",
    "entrypoint.shell-function-aios",
    "entrypoint.scaffold-bin-aios",
    "entrypoint.scaffold-scripts-aios",
    "linear.wrapper",
    "linear.skill-toolkit-copy",
    "linear.skill-scaffold-copy",
    "linear.skill-workstream-update",
    "linear.descriptor-query",
    "linear.descriptor-activity",
    "slack.wrapper",
    "slack.skill-python",
    "slack.descriptor-activity",
    "slack.descriptor-mcp",
    "update.linear-skill-overlay",
    "update.descriptor-overlay",
  ];
  const ids = new Set(inventory.routes.map((route) => route.id));
  for (const id of requiredIds) assert.ok(ids.has(id), `missing required route family ${id}`);

  for (const name of ["build", "spec", "consolidate-findings", "ship", "roadmap-run"]) {
    const route = inventory.routes.find((candidate) => candidate.id === `command.aios.${name}`);
    assert.equal(route?.futureOwner, "adapter.devtools", `${name}: devtools ownership drift`);
    assert.equal(route?.metadata?.implementation?.lazy, true, `${name}: devtools must be lazy`);
  }

  const update = inventory.routes.find((route) => route.id === "command.aios.update");
  assert.equal(update?.metadata?.networkBehavior, "required", "update performs network delivery");

  assert.match(inventory.evidence.coreBase, /^[0-9a-f]{40}$/);
  assert.match(inventory.evidence.devtoolsSource, /^[0-9a-f]{40}$/);
  assert.match(inventory.evidence.openClawSource, /^[0-9a-f]{40}$/);
  assert.equal(
    packageJson.dependencies["@aiosbrain/aios-devtools"],
    inventory.evidence.devtoolsPackage,
    "inventory must pin the devtools package version used by core"
  );
});

test("CLI architecture: repository evidence paths resolve", () => {
  for (const route of inventory.routes) {
    if (route.source.startsWith("@aiosbrain/")) continue;
    const sourcePath = route.source.split("#", 1)[0];
    assert.ok(
      existsSync(path.join(ROOT, sourcePath)),
      `${route.id}: source not found: ${sourcePath}`
    );

    for (const evidence of route.evidence) {
      if (evidence.startsWith("@aiosbrain/")) continue;
      const evidencePath = evidence.split("#", 1)[0];
      assert.ok(
        existsSync(path.join(ROOT, evidencePath)),
        `${route.id}: evidence not found: ${evidencePath}`
      );
    }
  }
});

test("CLI architecture: Node support and contract prose contain no TBD", () => {
  assert.deepEqual(inventory.supportedNodeMajors, [22, 24, 26]);
  assert.equal(packageJson.engines.node, inventory.currentPackageEngine);
  assert.equal(inventory.v2PackageEngine, "22.x || 24.x || 26.x");
  assert.match(ciSource, /node: \[22, 24, 26\]/, "CI must test the exact supported Node majors");
  assert.doesNotMatch(inventoryText, /\bTBD\b/i);
  assert.doesNotMatch(adr, /\bTBD\b/i);
});

test("CLI architecture: deferred runtime proofs are owned and mandatory before v2", () => {
  const expected = [
    "config-resolution",
    "credential-source-isolation",
    "destination-and-redirect-validation",
    "migration-and-rollback",
    "node-engine-and-devtools-compatibility",
    "output-errors-and-exits",
  ];
  assert.deepEqual(sorted(inventory.implementationProofs.map((proof) => proof.id)), expected);
  for (const proof of inventory.implementationProofs) {
    assert.ok(inventory.owners[proof.owner], `${proof.id}: unknown proof owner`);
    assert.equal(proof.status, "required-before-v2-release", `${proof.id}: deferral status`);
    assert.equal(proof.releaseBoundary, "v2.0.0", `${proof.id}: release boundary`);
    assert.ok(proof.tests.length >= 3, `${proof.id}: deterministic acceptance tests required`);
  }
  const transport = inventory.implementationProofs.find(
    (proof) => proof.id === "destination-and-redirect-validation"
  );
  assert.ok(
    transport.tests.some((criterion) => criterion.includes("AIOS_ALLOW_INSECURE_LOOPBACK=1"))
  );
  assert.match(adr, /AIOS_ALLOW_INSECURE_LOOPBACK=1/);

  const output = inventory.implementationProofs.find(
    (proof) => proof.id === "output-errors-and-exits"
  );
  assert.ok(
    output.tests.some(
      (criterion) =>
        criterion.includes("legacy linear and slack delegates") &&
        criterion.includes("stderr") &&
        criterion.includes("stdout and exit status")
    )
  );
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { COMMANDS } from "../scripts/cli/registry.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INVENTORY_PATH = path.join(ROOT, "docs", "architecture", "cli-command-inventory.v1.json");
const ADR_PATH = path.join(ROOT, "docs", "adr", "0002-single-binary-cli-platform.md");
const PACKAGE_PATH = path.join(ROOT, "package.json");

const inventoryText = readFileSync(INVENTORY_PATH, "utf8");
const inventory = JSON.parse(inventoryText);
const packageJson = JSON.parse(readFileSync(PACKAGE_PATH, "utf8"));
const adr = readFileSync(ADR_PATH, "utf8");

const sorted = (values) => [...values].sort((a, b) => a.localeCompare(b, "en"));

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
  const registered = inventory.routes.filter((route) => route.kind === "registered-command");
  assert.deepEqual(
    sorted(registered.map((route) => route.registryCommand)),
    sorted(COMMANDS.map((command) => command.name))
  );
  assert.equal(new Set(registered.map((route) => route.registryCommand)).size, registered.length);
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

  for (const connector of ["linear", "slack"]) {
    const route = inventory.routes.find(
      (candidate) => candidate.id === `command.aios.${connector}`
    );
    assert.equal(route?.route, `aios ${connector}`);
    assert.equal(route?.status, "planned-v2");
    assert.equal(route?.futureOwner, `adapter.${connector}`);
    assert.equal(route?.metadata?.implementation?.lazy, true);
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
  }
});

test("CLI architecture: Node support and contract prose contain no TBD", () => {
  assert.deepEqual(inventory.supportedNodeMajors, [22, 24, 26]);
  assert.equal(packageJson.engines.node, ">=22");
  assert.doesNotMatch(inventoryText, /\bTBD\b/i);
  assert.doesNotMatch(adr, /\bTBD\b/i);
});

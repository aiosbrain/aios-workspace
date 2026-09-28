import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUserConfig } from "../scripts/cli/config-broker.mjs";
import {
  prepareProfileMigration,
  validateProfiles,
  emptyGrants,
  effectiveGrants,
  nextGeneration,
} from "../scripts/mcp-profile-schema.mjs";
const profile = () => ({
  id: "demo",
  mode: "brain-only",
  generation: 1,
  brainOrigin: "https://brain.example.test",
  teamId: "team",
  projectId: "project",
  credentialSource: "brain",
  root: null,
  rootIdentity: null,
  grants: emptyGrants(),
  readRoots: [],
  draftRoots: [],
});
test("migration-preserves-unknown-and-absent-fields and no cwd/defaultWorkspace inference", () => {
  const before = {
    schemaVersion: 2,
    defaultWorkspace: "/old",
    credentialSources: { brain: "env:KEY" },
    extension: { retain: true },
  };
  const result = prepareProfileMigration(before);
  assert.deepEqual(result.document.connectionProfiles.profiles, []);
  assert.deepEqual(result.document.extension, before.extension);
  assert.deepEqual(result.document.credentialSources, before.credentialSources);
  assert.equal(prepareProfileMigration(result.document).changed, false);
  assert.equal("defaultWorkspace" in prepareProfileMigration({ schemaVersion: 2 }).document, false);
});
test("migration-no-grant-escalation and identical profiles retain grants", () => {
  const p = profile();
  p.grants.brainActions = true;
  assert.throws(() => prepareProfileMigration({ schemaVersion: 2 }, [p]), {
    code: "CAPABILITY_DENIED",
  });
  const doc = { schemaVersion: 2, connectionProfiles: { version: "1.0.0", profiles: [p] } };
  assert.equal(prepareProfileMigration(doc, [p]).changed, false);
  assert.deepEqual(
    parseUserConfig(JSON.stringify(doc)).known.connectionProfiles,
    doc.connectionProfiles
  );
});
test("unsupported-extension and duplicate-profile-id denied", () => {
  assert.throws(() => validateProfiles({ version: "2", profiles: [] }), {
    code: "INVALID_PROFILE",
  });
  assert.throws(() => validateProfiles({ version: "1.0.0", profiles: [profile(), profile()] }), {
    code: "INVALID_PROFILE",
  });
  assert.throws(() =>
    parseUserConfig(
      JSON.stringify({
        schemaVersion: 2,
        connectionProfiles: {
          version: "1.0.0",
          profiles: [{ ...profile(), credentialSource: "secret with spaces" }],
        },
      })
    )
  );
});
test("each-grant-independent and readonly overrides every mutation grant", () => {
  assert.deepEqual(
    effectiveGrants(
      { brainActions: true, workspaceRead: false, workspaceDraft: true, workspacePublish: true },
      true
    ),
    emptyGrants()
  );
  assert.equal(
    effectiveGrants({ ...emptyGrants(), workspaceRead: true }, true).workspaceRead,
    true
  );
  assert.throws(() => nextGeneration(2147483647), { code: "PROFILE_CHANGED" });
});

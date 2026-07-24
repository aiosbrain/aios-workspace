import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { DECISION_SYNC_VERSION, parseDecisionRows } from "../scripts/workspace-parse.mjs";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const AIOS = path.join(REPO, "scripts", "aios.mjs");
const execFileAsync = promisify(execFile);

const BODY = `## Decisions

| # | Date | Decision | Rationale | Decided By | Impact | Type | Audience |
|---|------|----------|-----------|------------|--------|------|----------|
| 1 | 2026-07-01 | Adopt X | public rationale | alex | high | 2 | team |
| 2 | 2026-07-02 | Severance terms | eyes-only rationale | john | high | 3 | private |
| 3 | 2026-07-03 | Ship V1 | go | sam | high | 2 | external |
| 4 | 2026-07-04 | Personnel note | admin-only detail | john | low | 3 | admin |
`;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function statusItems(workspace) {
  return JSON.parse(
    execFileSync("node", [AIOS, "status", "--json", "--repo", workspace], {
      cwd: REPO,
      encoding: "utf8",
    })
  ).items;
}

function makePreviouslySyncedWorkspace(decisionSyncVersion, brainUrl = "") {
  const workspace = mkdtempSync(path.join(tmpdir(), "aios-decision-resync-"));
  mkdirSync(path.join(workspace, "3-log"), { recursive: true });
  mkdirSync(path.join(workspace, ".aios"), { recursive: true });
  writeFileSync(
    path.join(workspace, "aios.yaml"),
    [
      "version: 1",
      `brain_url: "${brainUrl}"`,
      "sync_tiers:",
      "  - team",
      "sync_include:",
      "  - 3-log/decision-log.md",
    ].join("\n") + "\n"
  );
  const raw = `---\naccess: team\n---\n${BODY}`;
  writeFileSync(path.join(workspace, "3-log", "decision-log.md"), raw);
  const item = { sha: sha256(raw), remote_id: "old-item", pushed_at: "2026-07-01T00:00:00Z" };
  if (decisionSyncVersion !== undefined) item.decision_sync_version = decisionSyncVersion;
  writeFileSync(
    path.join(workspace, ".aios", "state.json"),
    JSON.stringify({ items: { "3-log/decision-log.md": item } })
  );
  return workspace;
}

test("an unchanged decision log without the redaction version is forced into the push plan", () => {
  const workspace = makePreviouslySyncedWorkspace(undefined);
  try {
    const items = statusItems(workspace);
    assert.deepEqual(items.clean, []);
    assert.deepEqual(
      items.modified.map((item) => item.rel),
      ["3-log/decision-log.md"]
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a decision log stamped with the current redaction version remains clean", () => {
  const workspace = makePreviouslySyncedWorkspace(DECISION_SYNC_VERSION);
  try {
    const items = statusItems(workspace);
    assert.deepEqual(items.modified, []);
    assert.deepEqual(
      items.clean.map((item) => item.rel),
      ["3-log/decision-log.md"]
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("legacy resync changes the outbound content hash so the Brain materializes redaction", async () => {
  let stored;
  let requestPayload;
  const server = createServer((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      requestPayload = JSON.parse(raw);
      const unchanged = requestPayload.content_sha256 === stored.content_sha256;
      if (!unchanged) stored = { ...requestPayload };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ id: "existing-item", status: unchanged ? "unchanged" : "updated" })
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const workspace = makePreviouslySyncedWorkspace(
    undefined,
    `http://127.0.0.1:${server.address().port}`
  );
  const source = readFileSync(path.join(workspace, "3-log", "decision-log.md"), "utf8");
  stored = {
    content_sha256: sha256(source),
    body: BODY,
    rows: parseDecisionRows(BODY),
  };

  try {
    const result = await execFileAsync("node", [AIOS, "push", "--repo", workspace], {
      cwd: REPO,
      encoding: "utf8",
      env: { ...process.env, AIOS_API_KEY: "qa-key" },
    });
    assert.match(result.stdout, /updated/);
    assert.notEqual(requestPayload.content_sha256, sha256(source));
    assert.deepEqual(
      stored.rows.map((row) => row.row_key),
      ["1", "3"]
    );
    assert.doesNotMatch(stored.body, /Severance terms|eyes-only rationale|admin-only detail/);
    const state = JSON.parse(readFileSync(path.join(workspace, ".aios", "state.json"), "utf8"));
    assert.equal(state.items["3-log/decision-log.md"].decision_sync_version, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(workspace, { recursive: true, force: true });
  }
});

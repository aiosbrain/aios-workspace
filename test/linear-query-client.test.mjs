import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { queryAssignedOpenIssues } from "../scaffold/.claude/descriptors/skills/linear-direct/linear-query-client.mjs";
import { resolveLinearKey } from "../scaffold/.claude/descriptors/skills/linear-direct/linear-query.mjs";

test("paginates every open issue assigned to the authenticated Linear viewer", async () => {
  const calls = [];
  const pages = [
    {
      data: {
        viewer: {
          name: "John",
          assignedIssues: {
            nodes: [{ id: "one" }, { id: "two" }],
            pageInfo: { hasNextPage: true, endCursor: "cursor-2" },
          },
        },
      },
    },
    {
      data: {
        viewer: {
          name: "John",
          assignedIssues: {
            nodes: [{ id: "three" }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
  ];
  const fetchImpl = async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return { ok: true, json: async () => pages.shift() };
  };

  const result = await queryAssignedOpenIssues({
    apiKey: "fixture-key",
    fetchImpl,
    pageSize: 2,
  });

  assert.deepEqual(
    result.viewer.assignedIssues.nodes.map((issue) => issue.id),
    ["one", "two", "three"]
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[1].variables.after, "cursor-2");
});

test("the assigned-open query excludes every resolved Linear state type", async () => {
  let request;
  const fetchImpl = async (_url, init) => {
    request = JSON.parse(init.body);
    return {
      ok: true,
      json: async () => ({
        data: {
          viewer: {
            name: "John",
            assignedIssues: {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      }),
    };
  };

  await queryAssignedOpenIssues({ apiKey: "fixture-key", fetchImpl });

  assert.match(request.query, /nin:\s*\["completed",\s*"canceled"\]/);
});

test("Linear key fallback never returns dotenvx ciphertext as a credential", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "aios-linear-key-"));
  writeFileSync(
    path.join(repo, ".env"),
    "DOTENV_PUBLIC_KEY=fixture\nLINEAR_API_KEY=encrypted:BNeverARealKey==\n"
  );

  assert.throws(
    () =>
      resolveLinearKey({
        repo,
        env: {},
        execFile: () => {
          throw new Error("dotenvx unavailable");
        },
      }),
    /LINEAR_API_KEY is dotenvx-encrypted/
  );
});

test("Linear key plaintext fallback trims whitespace before unquoting", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "aios-linear-key-"));
  writeFileSync(path.join(repo, ".env"), 'LINEAR_API_KEY="fixture-key"   # local key\n');

  assert.equal(
    resolveLinearKey({
      repo,
      env: {},
      execFile: () => {
        throw new Error("dotenvx unavailable");
      },
    }),
    "fixture-key"
  );
});

test("Linear key fallback rejects quoted ciphertext before an inline comment", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "aios-linear-key-"));
  writeFileSync(
    path.join(repo, ".env"),
    'LINEAR_API_KEY="encrypted:BNeverARealKey==" # local key\n'
  );

  assert.throws(
    () =>
      resolveLinearKey({
        repo,
        env: {},
        execFile: () => {
          throw new Error("dotenvx unavailable");
        },
      }),
    /LINEAR_API_KEY is dotenvx-encrypted/
  );
});

test("Linear key fallback treats a quoted-empty value as missing", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "aios-linear-key-"));
  writeFileSync(path.join(repo, ".env"), 'LINEAR_API_KEY="" # not connected\n');

  assert.throws(
    () =>
      resolveLinearKey({
        repo,
        env: {},
        execFile: () => {
          throw new Error("dotenvx unavailable");
        },
      }),
    /no LINEAR_API_KEY found/
  );
});

#!/usr/bin/env node
// test/linear-client.test.mjs — zero-dep, no-network Linear client.
// A fake fetch replays fixtures and records the request; asserts the POST shape, raw-key
// Authorization header, identifier→filter parse, mutation inputs, error → LinearError with
// the key redacted, bounded retry on 429/5xx, no retry on 4xx, and resolveLinearApiKey.
// Run: node test/linear-client.test.mjs

import {
  createLinearClient,
  resolveLinearApiKey,
  LinearError,
  LINEAR_API_URL,
} from "../scripts/linear-client.mjs";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let failed = 0;
const RED = "\x1b[0;31m",
  GREEN = "\x1b[0;32m",
  NC = "\x1b[0m";
function check(label, cond) {
  if (cond) console.log(`  ${GREEN}✓${NC} ${label}`);
  else {
    console.log(`  ${RED}✗${NC} ${label}`);
    failed++;
  }
}

// An obviously-fake placeholder key that matches NO secret-scanner regex.
const FAKE_KEY = "test-linear-key-fake";

function jsonResponse(data, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async json() {
      return data;
    },
    async text() {
      return JSON.stringify(data);
    },
  };
}

console.log("request shape + Authorization header");
{
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({ data: { issues: { nodes: [] } } });
  };
  const client = createLinearClient({ apiKey: FAKE_KEY, fetchFn });
  await client.getIssue("AIO-123");
  const { url, init } = calls[0];
  check("POST to LINEAR_API_URL", url === LINEAR_API_URL && init.method === "POST");
  check("Authorization is the RAW key (no Bearer)", init.headers.Authorization === FAKE_KEY);
  check("Content-Type json", init.headers["Content-Type"] === "application/json");
  const body = JSON.parse(init.body);
  check("body has query + variables", typeof body.query === "string" && !!body.variables);
  check(
    "AIO-123 → team AIO + number 123",
    body.variables.key === "AIO" && body.variables.num === 123
  );
}

console.log("getIssue normalization");
{
  const node = {
    identifier: "AIO-5",
    title: "T",
    description: "D",
    priority: 2,
    createdAt: "2026-01-01T00:00:00Z",
    state: { name: "Todo", type: "unstarted" },
    assignee: { name: "Alex", id: "u1" },
    labels: { nodes: [{ name: "ship" }] },
    parent: { identifier: "AIO-1" },
    children: { nodes: [{ identifier: "AIO-6", title: "child", state: { type: "unstarted" } }] },
    comments: { nodes: [{ body: "hi", user: { name: "Sam" }, createdAt: "x" }] },
    attachments: { nodes: [{ url: "https://example.test/pr/1" }] },
    relations: { nodes: [] },
    inverseRelations: { nodes: [] },
  };
  const fetchFn = async () => jsonResponse({ data: { issues: { nodes: [node] } } });
  const client = createLinearClient({ apiKey: FAKE_KEY, fetchFn });
  const iss = await client.getIssue("AIO-5", { full: true });
  check("labels flattened", Array.isArray(iss.labels) && iss.labels[0] === "ship");
  check("children flattened", iss.children[0].identifier === "AIO-6");
  check("comments flattened", iss.comments[0].body === "hi");
  check("attachments → urls", iss.attachments[0] === "https://example.test/pr/1");
  check("blockedBy empty when no relations", iss.blockedBy.length === 0);
}

console.log("createIssue + addComment mutation inputs");
{
  const calls = [];
  const fetchFn = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    if (/IssueMeta/.test(body.query)) {
      return jsonResponse({
        data: {
          issues: {
            nodes: [{ id: "uuid-parent", identifier: "AIO-1", team: { id: "team-1", key: "AIO" } }],
          },
        },
      });
    }
    if (/issueCreate/.test(body.query)) {
      return jsonResponse({
        data: { issueCreate: { success: true, issue: { identifier: "AIO-99" } } },
      });
    }
    if (/commentCreate/.test(body.query)) {
      return jsonResponse({ data: { commentCreate: { success: true } } });
    }
    return jsonResponse({ data: {} });
  };
  const client = createLinearClient({ apiKey: FAKE_KEY, fetchFn });
  const created = await client.createIssue({
    title: "Deferred: do X",
    description: "body",
    parentIdentifier: "AIO-1",
  });
  check("createIssue returns identifier", created.identifier === "AIO-99");
  const createBody = calls.find((b) => /issueCreate/.test(b.query));
  check(
    "createIssue input carries title/teamId/parentId",
    createBody.variables.input.title === "Deferred: do X" &&
      createBody.variables.input.teamId === "team-1" &&
      createBody.variables.input.parentId === "uuid-parent"
  );
  const res = await client.addComment("AIO-1", "escalation note");
  check("addComment ok", res.ok === true);
  const commentBody = calls.find((b) => /commentCreate/.test(b.query));
  check(
    "addComment input carries issueId + body",
    commentBody.variables.input.issueId === "uuid-parent" &&
      commentBody.variables.input.body === "escalation note"
  );
}

console.log("mutations never retry (no duplicate issue/comment on a lost response)");
{
  // A 503 on the mutation must surface immediately — retrying could duplicate an accepted write.
  let creates = 0;
  const fetchFn = async (url, init) => {
    const body = JSON.parse(init.body);
    if (/IssueMeta/.test(body.query)) {
      return jsonResponse({
        data: {
          issues: {
            nodes: [{ id: "uuid-parent", identifier: "AIO-1", team: { id: "team-1", key: "AIO" } }],
          },
        },
      });
    }
    if (/issueCreate/.test(body.query)) {
      creates++;
      return jsonResponse({}, { ok: false, status: 503 });
    }
    return jsonResponse({ data: {} });
  };
  const client = createLinearClient({ apiKey: FAKE_KEY, fetchFn, maxRetries: 1 });
  let threw = false;
  try {
    await client.createIssue({ title: "X", parentIdentifier: "AIO-1" });
  } catch {
    threw = true;
  }
  check("issueCreate 503 not retried (attempted once)", creates === 1 && threw);

  let comments = 0;
  const fetch2 = async (url, init) => {
    const body = JSON.parse(init.body);
    if (/IssueMeta/.test(body.query)) {
      return jsonResponse({
        data: {
          issues: { nodes: [{ id: "uuid-1", identifier: "AIO-1", team: { id: "t", key: "AIO" } }] },
        },
      });
    }
    if (/commentCreate/.test(body.query)) {
      comments++;
      return jsonResponse({}, { ok: false, status: 503 });
    }
    return jsonResponse({ data: {} });
  };
  const c2 = createLinearClient({ apiKey: FAKE_KEY, fetchFn: fetch2, maxRetries: 1 });
  let threw2 = false;
  try {
    await c2.addComment("AIO-1", "note");
  } catch {
    threw2 = true;
  }
  check("commentCreate 503 not retried (attempted once)", comments === 1 && threw2);
}

console.log("listIssues label filter uses the implicit-some shape (labels.name.eq)");
{
  let listFilter = null;
  const fetchFn = async (url, init) => {
    const body = JSON.parse(init.body);
    if (/ListIssues/.test(body.query)) listFilter = body.variables.filter;
    return jsonResponse({ data: { issues: { nodes: [], pageInfo: { hasNextPage: false } } } });
  };
  const client = createLinearClient({ apiKey: FAKE_KEY, fetchFn });
  await client.listIssues({ label: "ship" });
  check(
    "label filter is { labels: { name: { eq } } } (no extra `some` wrapper)",
    listFilter &&
      listFilter.labels &&
      listFilter.labels.name &&
      listFilter.labels.name.eq === "ship" &&
      !("some" in listFilter.labels)
  );
}

console.log("errors → LinearError, key redacted");
{
  const fetchFn = async () => jsonResponse({}, { ok: false, status: 401 });
  const client = createLinearClient({ apiKey: FAKE_KEY, fetchFn });
  let threw = null;
  try {
    await client.getIssue("AIO-1");
  } catch (e) {
    threw = e;
  }
  check("HTTP 401 throws LinearError", threw instanceof LinearError);
  check("401 message mentions status", /401/.test(threw.message));

  // A body that echoes the key must come back redacted.
  const echo = async () => ({
    ok: false,
    status: 403,
    async text() {
      return `denied for key ${FAKE_KEY}`;
    },
    async json() {
      return {};
    },
  });
  const c2 = createLinearClient({ apiKey: FAKE_KEY, fetchFn: echo });
  let e2 = null;
  try {
    await c2.getIssue("AIO-1");
  } catch (e) {
    e2 = e;
  }
  check(
    "key never appears in error text",
    e2 instanceof LinearError && !e2.message.includes(FAKE_KEY)
  );

  // GraphQL errors[] → LinearError.
  const gqlErr = async () => jsonResponse({ errors: [{ message: "bad field" }] });
  const c3 = createLinearClient({ apiKey: FAKE_KEY, fetchFn: gqlErr });
  let e3 = null;
  try {
    await c3.getIssue("AIO-1");
  } catch (e) {
    e3 = e;
  }
  check("errors[] throws LinearError", e3 instanceof LinearError && /bad field/.test(e3.message));
}

console.log("retry: 429/5xx once then success; 400 no retry");
{
  let n = 0;
  const fetchFn = async () => {
    n++;
    if (n === 1) return jsonResponse({}, { ok: false, status: 503 });
    return jsonResponse({ data: { issues: { nodes: [] } } });
  };
  const client = createLinearClient({ apiKey: FAKE_KEY, fetchFn, maxRetries: 1 });
  await client.getIssue("AIO-1");
  check("retried once on 503 then succeeded", n === 2);

  let m = 0;
  const fetch400 = async () => {
    m++;
    return jsonResponse({}, { ok: false, status: 400 });
  };
  const c2 = createLinearClient({ apiKey: FAKE_KEY, fetchFn: fetch400, maxRetries: 1 });
  let threw = false;
  try {
    await c2.getIssue("AIO-1");
  } catch {
    threw = true;
  }
  check("no retry on 400", m === 1 && threw);
}

console.log("resolveLinearApiKey: env → dotenv → null");
{
  const saved = process.env.LINEAR_API_KEY;
  process.env.LINEAR_API_KEY = "  env-key-fake  ";
  check("env wins (trimmed)", resolveLinearApiKey(null) === "env-key-fake");
  delete process.env.LINEAR_API_KEY;

  const repo = mkdtempSync(path.join(tmpdir(), "lc-dot-"));
  writeFileSync(path.join(repo, ".env"), "LINEAR_API_KEY=dot-key-fake\n");
  check("falls back to .env", resolveLinearApiKey(repo) === "dot-key-fake");

  const empty = mkdtempSync(path.join(tmpdir(), "lc-empty-"));
  check("null when unresolved", resolveLinearApiKey(empty) === null);
  rmSync(repo, { recursive: true, force: true });
  rmSync(empty, { recursive: true, force: true });
  if (saved !== undefined) process.env.LINEAR_API_KEY = saved;
}

console.log(failed ? `${RED}${failed} check(s) failed${NC}` : `${GREEN}all checks passed${NC}`);
process.exit(failed ? 1 : 0);

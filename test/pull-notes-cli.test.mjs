import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "../scripts/workspace-parse.mjs";
import { scrubEnv } from "./helpers/scrubbed-env.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(repo, "scripts/aios.mjs");
// Captured from a disposable production Brain POST note.append + GET /items/<id>.
// The fixture retains exact accepted CRLF, combining marks, astral Unicode and title delimiters.
const accepted = JSON.parse(
  readFileSync(new URL("./fixtures/notes/accepted-note.json", import.meta.url), "utf8")
);
const key = "aios_note_pull_fixture_only";
const legacyKinds = [
  "deliverable",
  "transcript",
  "decision",
  "task",
  "artifact",
  "skill",
  "blueprint",
  "fact",
  "stakeholder_mention",
];

function runCli(args, workspace) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args, "--repo", workspace], {
      cwd: repo,
      env: scrubEnv(process.env, { add: { AIOS_API_KEY: key, AIOS_MEMBER: "pull-fixture" } }),
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function fixture(pages) {
  const requests = [],
    pushes = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    requests.push({
      method: req.method,
      route: url.pathname,
      since: url.searchParams.get("since"),
      cursor: url.searchParams.get("cursor"),
    });
    const send = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (
      req.headers.authorization !== `Bearer ${key}` ||
      req.headers["x-aios-team"] !== "fixture-team"
    )
      return send(401, { error: { message: "fixture authentication required" } });
    if (req.method === "POST") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      pushes.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      return send(201, { status: "created", id: "authored-fixture-id" });
    }
    if (url.pathname === "/api/v1/items") {
      const page = Number(url.searchParams.get("cursor") || "0");
      return send(200, {
        items: pages[page],
        next_cursor: page + 1 < pages.length ? String(page + 1) : null,
      });
    }
    if (url.pathname === "/api/v1/tasks") return send(200, { tasks: [] });
    return send(404, {
      error: { code: "not_found", message: "optional fixture endpoint unavailable" },
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const workspace = mkdtempSync(path.join(tmpdir(), "aios-note-pull-"));
  mkdirSync(path.join(workspace, "1-inbox"));
  mkdirSync(path.join(workspace, "2-work"));
  writeFileSync(
    path.join(workspace, "aios.yaml"),
    [
      "version: 1",
      `brain_url: http://127.0.0.1:${server.address().port}`,
      "team_id: fixture-team",
      "member: pull-fixture",
      "sync_tiers:",
      "  - team",
      "sync_include:",
      "  - 1-inbox",
      "  - 2-work",
    ].join("\n") + "\n"
  );
  return {
    workspace,
    requests,
    pushes,
    close: async () => {
      rmSync(workspace, { recursive: true, force: true });
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
const destName = (item) =>
  `${item.project.replaceAll("/", "__")}__${item.path.replaceAll("/", "__")}`;
const inbox = (f) => path.join(f.workspace, "1-inbox/from-brain");

function assertAcceptedProjection(file, item = accepted) {
  const text = readFileSync(file, "utf8");
  const parsed = parseFrontmatter(text);
  assert.equal(parsed.body, item.body);
  assert.equal(parsed.frontmatter.from_brain, "true");
  // The restricted workspace parser deliberately does not decode YAML escapes;
  // the generated JSON-compatible scalars themselves must decode to exact metadata.
  const end = text.indexOf("\n---\n", 4);
  const metadata = Object.fromEntries(
    text
      .slice(4, end)
      .split("\n")
      .map((line) => {
        const colon = line.indexOf(":");
        return [line.slice(0, colon), JSON.parse(line.slice(colon + 1))];
      })
  );
  assert.equal(metadata.title, item.frontmatter.title);
  assert.equal(metadata.origin_item_id, item.id);
  assert.equal(metadata.origin_project, item.project);
  assert.equal(metadata.origin_path, item.path);
  assert.equal(metadata.origin_actor, item.actor);
  assert.equal(metadata.kind, "note");
  assert.equal(metadata.access, "team");
  assert.equal(metadata.from_brain, true);
}

test("CLI skips malformed future kinds, advances pagination, preserves legacy kinds and exact accepted notes on repeat", async () => {
  const legacy = legacyKinds.map((kind) => ({
    ...accepted,
    id: `legacy-${kind}`,
    kind,
    path: `${kind}.md`,
    body: `Legacy ${kind}\r\n`,
    frontmatter: {},
  }));
  const f = await fixture([
    [null, {}, { kind: "future-kind", project: null, path: { invalid: true } }],
    [...legacy, accepted],
  ]);
  try {
    for (let run = 0; run < 2; run++) {
      const result = await runCli(["pull"], f.workspace);
      assert.equal(result.code, 0, result.stderr + result.stdout);
      assert.deepEqual(readdirSync(inbox(f)).sort(), [...legacy, accepted].map(destName).sort());
      assertAcceptedProjection(path.join(inbox(f), destName(accepted)));
      for (const item of legacy)
        assert.equal(
          parseFrontmatter(readFileSync(path.join(inbox(f), destName(item)), "utf8")).body,
          item.body
        );
      const state = JSON.parse(readFileSync(path.join(f.workspace, ".aios/state.json"), "utf8"));
      assert.ok(Date.parse(state.last_pull) > Date.parse("1970-01-01"));
    }
    const itemRequests = f.requests.filter((request) => request.route === "/api/v1/items");
    assert.deepEqual(
      itemRequests.map((request) => request.cursor),
      [null, "1", null, "1"]
    );
    assert.notEqual(itemRequests[2].since, "1970-01-01T00:00:00Z");
    assert.equal(
      f.requests.some((request) => request.method !== "GET"),
      false
    );
  } finally {
    await f.close();
  }
});

test("explicit inbox inclusion holds generated mirrors while a separately authored document can use existing publication rules", async () => {
  const f = await fixture([[accepted, { ...accepted, kind: "deliverable", path: "legacy.md" }]]);
  try {
    assert.equal((await runCli(["pull"], f.workspace)).code, 0);
    const held = await runCli(["push"], f.workspace);
    assert.equal(held.code, 0, held.stderr + held.stdout);
    assert.equal(
      f.pushes.length,
      0,
      "read-only note mirror must never be published as an artifact"
    );
    const status = await runCli(["status"], f.workspace);
    assert.match(status.stdout, /read-only Brain mirror/);
    writeFileSync(
      path.join(f.workspace, "2-work/authored.md"),
      "---\naccess: team\nkind: note\n---\nSeparately authored note content.\n"
    );
    const authored = await runCli(["push"], f.workspace);
    assert.equal(authored.code, 0, authored.stderr + authored.stdout);
    assert.equal(f.pushes.length, 1);
    assert.equal(f.pushes[0].path, "2-work/authored.md");
    assert.equal(
      f.pushes[0].kind,
      "deliverable",
      "existing path-based kind rules remain unchanged"
    );
    assertAcceptedProjection(path.join(inbox(f), destName(accepted)));
  } finally {
    await f.close();
  }
});

test("recognized note paths remain confined by the existing flattening and safe-join boundary", async () => {
  const item = { ...accepted, project: "../../outside", path: "../../../escape.md" };
  const f = await fixture([[item]]);
  try {
    const result = await runCli(["pull"], f.workspace);
    assert.equal(result.code, 0, result.stderr + result.stdout);
    assert.deepEqual(readdirSync(inbox(f)), [destName(item)]);
    assertAcceptedProjection(path.join(inbox(f), destName(item)), item);
    assert.equal(existsSync(path.join(f.workspace, "escape.md")), false);
  } finally {
    await f.close();
  }
});

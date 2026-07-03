// Distillation (AIO-192, Blocker #2 / Majors #3-#4). Unit-tests the pure `distill` seam with a mock
// CompletionFn (valid → draft citing real ids; junk → clean throw, no partial doc) and the fail-
// closed min-support / path-free projection, plus the CLI egress gate (`--remote` required even
// with a key) and the default admin-store output path.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendDecision,
  readDecisions,
  distill,
  projectForDistill,
} from "../../dist/operator-loop/index.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(ROOT, "scripts", "aios.mjs");
const DRAFT_REL = ".aios/loop/decisions/decision-principles.draft.md";

function ws() {
  return mkdtempSync(path.join(tmpdir(), "distill-"));
}
function seed(dir, n = 4) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const r = appendDecision(dir, {
      kind: "ask-user-question",
      question: `Q${i}: pick a database?`,
      choice: ["Postgres"],
      contextTag: "aios",
      source: "backfill",
      context: {
        sessionId: `s${i}`,
        cwd: "/secret/abs/path",
        transcriptPath: "/secret/t.jsonl",
        project: "secret",
      },
    });
    ids.push(r.id);
  }
  return ids;
}

test("distill: valid model output → draft where every principle cites >= minSupport real ids", async () => {
  const dir = ws();
  try {
    const ids = seed(dir, 4);
    let sentUser = null;
    const complete = async (req) => {
      sentUser = req.user;
      return {
        principles: [
          {
            title: "Prefer Postgres",
            principle: "Default to Postgres.",
            contexts: ["aios"],
            evidence: ids.slice(0, 3),
          },
        ],
      };
    };
    const { markdown, principles, used } = await distill({
      records: readAll(dir),
      minSupport: 3,
      complete,
    });
    assert.equal(principles.length, 1);
    assert.equal(used, 4);
    assert.match(markdown, /DRAFT — FOR HUMAN REVIEW/);
    // Path-free projection: no absolute paths reach the model prompt.
    assert.ok(!/\/secret\/abs\/path/.test(sentUser), "cwd path stripped before egress");
    assert.ok(!/secret/.test(sentUser), "no project name / paths in the projected corpus");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("distill: junk output throws (no partial doc); an under-supported principle throws", async () => {
  const dir = ws();
  try {
    const ids = seed(dir, 4);
    await assert.rejects(
      () =>
        distill({ records: readAll(dir), minSupport: 3, complete: async () => ({ nope: true }) }),
      /no principles array/
    );
    // cites only 1 real id but 2 fabricated ones → fewer than minSupport valid → throw
    await assert.rejects(
      () =>
        distill({
          records: readAll(dir),
          minSupport: 3,
          complete: async () => ({
            principles: [{ title: "X", principle: "Y", evidence: [ids[0], "fake-1", "fake-2"] }],
          }),
        }),
      /cites 1 valid corpus id/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("distill: contextFilter narrows the corpus; too-small corpus throws before any call", async () => {
  const dir = ws();
  try {
    seed(dir, 4);
    let called = false;
    await assert.rejects(
      () =>
        distill({
          records: readAll(dir),
          minSupport: 3,
          contextFilter: "products",
          complete: async () => {
            called = true;
            return {};
          },
        }),
      /need at least 3/
    );
    assert.equal(called, false, "no completion call when the corpus is too small");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("projectForDistill strips every path-bearing field", () => {
  const dir = ws();
  try {
    seed(dir, 1);
    const [p] = projectForDistill(readAll(dir));
    assert.ok(!("cwd" in p) && !("transcriptPath" in p) && !("context" in p));
    assert.equal(p.contextTag, "aios");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── CLI gate ──────────────────────────────────────────────────────────────────────────────────

function runCli(dir, args, env = {}) {
  const r = spawnSync("node", [CLI, "decisions", ...args, "--repo", dir], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { code: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

test("CLI distill fails without --remote even when ANTHROPIC_API_KEY is set, and writes no file", () => {
  const dir = ws();
  try {
    seed(dir, 4);
    const res = runCli(dir, ["distill"], { ANTHROPIC_API_KEY: "sk-test" });
    assert.notEqual(res.code, 0, "no --remote → refuse");
    assert.match(res.err, /--remote to consent/);
    assert.equal(existsSync(path.join(dir, DRAFT_REL)), false, "no draft written");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI distill with --remote + stubbed completion writes the draft to the admin store by default", () => {
  const dir = ws();
  try {
    const ids = seed(dir, 4);
    const stub = path.join(dir, "stub.json");
    writeFileSync(
      stub,
      JSON.stringify({
        principles: [{ title: "T", principle: "P", contexts: ["aios"], evidence: ids.slice(0, 3) }],
      })
    );
    const res = runCli(dir, ["distill", "--remote", "--json"], { AIOS_DISTILL_STUB_FILE: stub });
    assert.equal(res.code, 0);
    const parsed = JSON.parse(res.out);
    assert.equal(parsed.principles, 1);
    // Default out is inside the gitignored .aios/ store (NOT docs/).
    assert.ok(
      parsed.out.includes(path.join(".aios", "loop", "decisions")),
      "default draft under .aios/"
    );
    assert.ok(existsSync(path.join(dir, DRAFT_REL)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI distill --out into a tracked path prints the outside-admin-store notice", () => {
  const dir = ws();
  try {
    const ids = seed(dir, 4);
    const stub = path.join(dir, "stub.json");
    writeFileSync(
      stub,
      JSON.stringify({ principles: [{ title: "T", principle: "P", evidence: ids.slice(0, 3) }] })
    );
    const res = runCli(dir, ["distill", "--remote", "--out", "docs/review-principles.md"], {
      AIOS_DISTILL_STUB_FILE: stub,
    });
    assert.equal(res.code, 0);
    assert.match(res.err, /OUTSIDE the ignored \.aios\/ store/);
    assert.ok(existsSync(path.join(dir, "docs", "review-principles.md")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// helper: read the folded corpus back
function readAll(dir) {
  return readDecisions(dir).decisions;
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eventsFromRecords, parseJsonl } from "../../dist/operator-loop/index.js";

test("parseJsonl tolerates blank and garbled lines", () => {
  const txt = '{"a":1}\n\n not json \n{"b":2}\n';
  assert.equal(parseJsonl(txt).length, 2);
});

test("eventsFromRecords drops records without a parseable timestamp", () => {
  const recs = [
    {
      type: "user",
      timestamp: "2026-07-01T10:00:00Z",
      cwd: "/x",
      message: { role: "user", content: "hi" },
    },
    { type: "user", cwd: "/x", message: { role: "user", content: "no ts" } },
    {
      type: "assistant",
      timestamp: "nonsense",
      cwd: "/x",
      message: { role: "assistant", content: [] },
    },
  ];
  const evs = eventsFromRecords(recs, "s1");
  assert.equal(evs.length, 1);
  assert.equal(evs[0].actor, "user");
});

test("eventsFromRecords emits a tool_use event per assistant tool block", () => {
  const recs = [
    {
      type: "assistant",
      timestamp: "2026-07-01T10:00:00Z",
      cwd: "/x",
      isSidechain: false,
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "..." },
          { type: "tool_use", name: "Bash" },
          { type: "tool_use", name: "Edit" },
        ],
      },
    },
  ];
  const evs = eventsFromRecords(recs, "s1");
  assert.equal(evs.length, 3); // 1 turn + 2 tool_use
  assert.deepEqual(
    evs
      .filter((e) => e.toolName)
      .map((e) => e.toolName)
      .sort(),
    ["Bash", "Edit"]
  );
  assert.equal(evs[0].actor, "assistant");
});

test("eventsFromRecords marks sidechain turns as subagent", () => {
  const recs = [
    {
      type: "assistant",
      timestamp: "2026-07-01T10:00:00Z",
      cwd: "/x",
      isSidechain: true,
      message: { role: "assistant", content: [] },
    },
  ];
  assert.equal(eventsFromRecords(recs, "s1")[0].actor, "subagent");
});

test("eventsFromRecords canonicalizes cwd through a symlink", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "aios-time-sym-"));
  const real = path.join(tmp, "realrepo");
  mkdirSync(real);
  const link = path.join(tmp, "linkrepo");
  symlinkSync(real, link);
  const recs = [
    {
      type: "user",
      timestamp: "2026-07-01T10:00:00Z",
      cwd: link,
      message: { role: "user", content: "hi" },
    },
  ];
  assert.equal(eventsFromRecords(recs, "s1")[0].cwdRealpath, realpathSync(real));
  rmSync(tmp, { recursive: true, force: true });
});

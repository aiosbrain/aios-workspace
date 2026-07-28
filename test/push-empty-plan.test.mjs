// What `aios push` SAYS when nothing is going to leave (audit S4-7).
//
// A path argument that matched nothing used to fall through to "nothing to push — all eligible
// files are clean", so `aios push 2-work/reprot.md` (one character off) reported a file that does
// not exist as already synced. A path outside the repo got the same reassuring line. "Matched
// nothing" is a caller error, not a clean state — these pin both halves, plus the dry-run
// transcript that moved out of cmdPush alongside it.

import test from "node:test";
import assert from "node:assert/strict";
import { describeEmptyPush, renderDryRunPlan } from "../scripts/sync-plan.mjs";

const plain = { yellow: (s) => s, blue: (s) => s };
const plan = (over = {}) => ({ push: [], blocked: [], clean: [], ...over });

test("a plan with something to push is not 'empty'", () => {
  assert.equal(describeEmptyPush(plan({ push: [{ rel: "2-work/index.md" }] }), []), null);
  assert.equal(describeEmptyPush(plan({ push: [{ rel: "a.md" }] }), ["a.md"]), null);
});

test("explicit paths that match nothing are fatal and name the paths", () => {
  const r = describeEmptyPush(plan(), ["2-work/indx.md"]);
  assert.equal(r.fatal, true);
  assert.match(r.message, /no file in this workspace matches: 2-work\/indx\.md/);
  assert.match(r.message, /run 'aios status'/);
  assert.doesNotMatch(r.message, /clean/, "must not claim a missing file is clean");
});

test("several unmatched paths are all named", () => {
  const r = describeEmptyPush(plan(), ["a.md", "b.md"]);
  assert.match(r.message, /a\.md, b\.md/);
});

test("a path that matched a HELD file is clean-with-a-note, not fatal", () => {
  const r = describeEmptyPush(plan({ blocked: [{ rel: "x.md", reason: "admin" }] }), ["x.md"]);
  assert.ok(!r.fatal);
  assert.match(r.message, /nothing to push/);
  assert.match(r.note, /1 held — run 'aios status' for reasons/);
});

test("a path that matched a CLEAN file is clean, not fatal", () => {
  const r = describeEmptyPush(plan({ clean: [{ rel: "x.md" }] }), ["x.md"]);
  assert.ok(!r.fatal);
  assert.equal(r.note, undefined);
});

test("a whole-workspace push with nothing to send stays non-fatal", () => {
  const r = describeEmptyPush(plan(), []);
  assert.ok(!r.fatal);
  assert.match(r.message, /all eligible files are clean/);
});

test("the dry-run transcript lists tier and sha per item, then the held list", () => {
  const lines = renderDryRunPlan(
    {
      push: [
        { rel: "2-work/index.md", kind: "deliverable", tier: "team", hash: "8a8c75251af1beef" },
        {
          rel: "3-log/tasks-team.md",
          kind: "task",
          tier: "team",
          hash: "01be4fb5f065cafe",
          rows: [1],
        },
      ],
      blocked: [{ rel: ".claude/memory/USER.md", reason: "`access: admin` never syncs" }],
    },
    { c: plain }
  );
  assert.match(lines[0], /would push 2 item\(s\)/);
  assert.equal(lines[1], "  2-work/index.md [deliverable, team] sha=8a8c75251af1");
  assert.match(lines[2], /rows=1 sha=01be4fb5f065$/);
  assert.match(lines[3], /held \(1\)/);
  assert.match(lines[4], /USER\.md — `access: admin` never syncs/);
});

test("the dry-run transcript omits the held block when nothing is held", () => {
  const lines = renderDryRunPlan({ push: [], blocked: [] }, { c: plain });
  assert.equal(lines.length, 1);
});

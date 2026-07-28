import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAskIds, resolveAsksResponse, askDetailResponse } from "./asks.mjs";

test("parseAskIds accepts {id} and {ids}, and requires at least one", () => {
  assert.deepEqual(parseAskIds(JSON.stringify({ id: "3fea973d" })), ["3fea973d"]);
  assert.deepEqual(parseAskIds(JSON.stringify({ ids: ["3fea973d", "8d9b0108"] })), [
    "3fea973d",
    "8d9b0108",
  ]);
  // A collapsed row resolves every folded ask in one call — the multi-id path is the normal case.
  assert.equal(parseAskIds(JSON.stringify({ ids: Array(7).fill("3fea973d") })).length, 7);

  for (const empty of ["{}", JSON.stringify({ ids: [] }), JSON.stringify({ id: null })]) {
    assert.throws(
      () => parseAskIds(empty),
      (e) => e.statusCode === 400,
      `expected 400 for ${empty}`
    );
  }
});

test("parseAskIds rejects a malformed body rather than treating it as empty", () => {
  assert.throws(
    () => parseAskIds("not json"),
    (e) => e.statusCode === 400 && /invalid JSON/.test(e.message)
  );
});

test("parseAskIds validates EVERY id — one bad entry fails the whole request", () => {
  // The ids are spliced into argv. Silently dropping the bad one would resolve a DIFFERENT set
  // of asks than the operator asked for, which is worse than refusing.
  assert.throws(
    () => parseAskIds(JSON.stringify({ ids: ["3fea973d", "--json"] })),
    (e) => e.statusCode === 400
  );
  assert.throws(
    () => parseAskIds(JSON.stringify({ ids: ["3fea973d", "-8d9b0108"] })),
    (e) => e.statusCode === 400
  );
});

test("resolveAsksResponse: success echoes the ids; a CLI failure is a 500, never a false ok", () => {
  const ok = resolveAsksResponse({ exitCode: 0, stdout: "{}", stderr: "" }, ["a1b2c3d4"]);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { ok: true, resolved: ["a1b2c3d4"] });

  // Reporting success here would tell the operator a blocker was cleared while it is still open.
  const bad = resolveAsksResponse({ exitCode: 1, stdout: "", stderr: "no such ask\n" }, [
    "a1b2c3d4",
  ]);
  assert.equal(bad.status, 500);
  assert.equal(bad.json.ok, false);
  assert.equal(bad.json.error, "no such ask");

  const silent = resolveAsksResponse({ exitCode: 1, stdout: "", stderr: "   " }, ["a1b2c3d4"]);
  assert.equal(
    silent.json.error,
    "asks resolve failed",
    "empty stderr must not yield a blank error"
  );
});

test("askDetailResponse: 200 with the parsed ask, 404 when it does not resolve", () => {
  const ask = { id: "a1b2c3d4", title: "Reconnect WhatsApp", body: "Pair the device again." };
  const ok = askDetailResponse({ exitCode: 0, stdout: JSON.stringify(ask), stderr: "" });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, ask);

  // A well-formed but unknown id must not render as an empty detail pane that says nothing.
  const missing = askDetailResponse({ exitCode: 1, stdout: "", stderr: "ask not found: deadbeef" });
  assert.equal(missing.status, 404);
  assert.match(missing.json.error, /not found/);

  const silent = askDetailResponse({ exitCode: 1, stdout: "", stderr: "" });
  assert.equal(silent.json.error, "ask not found");
});

test("askDetailResponse: unparseable stdout is a 500, not a 404", () => {
  // A broken CLI contract is not the same as a missing ask, and must not be reported as one.
  const r = askDetailResponse({ exitCode: 0, stdout: "<html>oops", stderr: "" });
  assert.equal(r.status, 500);
  assert.match(r.json.error, /could not parse/);
});

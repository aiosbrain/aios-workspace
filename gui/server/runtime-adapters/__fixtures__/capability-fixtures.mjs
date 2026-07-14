// Capability fixture matrix builders (I-07 / AIO-388).
//
// Helpers that construct VALID and adversarially-MUTATED capability envelopes, handles, and durable
// store records for `test/operator-loop/inbox-capability.test.mjs`. They compose the store's own line
// encoders (`issueLine`/`consumeLine`/`receiptLine`) so a fixture can seed a store in ANY intermediate
// state — including the crash windows a live `consumeAndExecute` can never leave behind mid-call
// (tombstone committed, outcome line missing). Everything here is synthetic + admin-tier local; nothing
// syncs (see the I-07 tier-safety note). No real comms plaintext.
//
// Layout follows the __fixtures__ convention (beside the recorded-transcript JSON fixtures).

import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  makeIssueRecord,
  issueLine,
  consumeLine,
  capabilityDigest,
  CAPABILITY_STORE_REL,
} from "../capability-store.mjs";

export const FIXTURE_IDENTITY = "/repo/aios-workspace@feat/inbox";
export const FIXTURE_AUDIENCE = "runtime-A/session-X";
export const FIXTURE_EPOCH = "key-epoch-1";

/** A throwaway workspace root for one fixture. */
export function ws() {
  return mkdtempSync(path.join(tmpdir(), "inbox-capfix-"));
}

/** A canonical, valid capability request. `over` mutates any field for the adversarial builders. */
export function sampleRequest(over = {}) {
  return {
    operation: "Bash",
    normalizedArgs: { command: "git status" },
    targetResources: ["cmd:git"],
    repoWorktreeIdentity: FIXTURE_IDENTITY,
    ...over,
  };
}

/** A valid brokered-decision envelope (approve, echoing the request digest). Bypasses the coordinator. */
export function brokeredFor(record, over = {}) {
  return {
    handle: record.handle,
    decision: "approve",
    digest: record.requestDigest,
    brokeredAt: new Date().toISOString(),
    ...over,
  };
}

function storeAbs(root) {
  return path.join(root, CAPABILITY_STORE_REL);
}

/** Append raw NDJSON lines to the store, creating the directory tree if needed. */
export function appendLines(root, lines) {
  const abs = storeAbs(root);
  mkdirSync(path.dirname(abs), { recursive: true });
  for (const line of lines) appendFileSync(abs, line + "\n");
  return abs;
}

/** Overwrite the store with exactly `lines` (for a hand-crafted crash-window / tamper transcript). */
export function writeStore(root, lines) {
  const abs = storeAbs(root);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, lines.map((l) => l + "\n").join(""));
  return abs;
}

/**
 * Seed a store with a single ISSUE line for a (possibly mutated) record. Returns { root, record }.
 * `mutate(record)` runs AFTER the valid record (integrity + digest already computed) is built, so a
 * caller can tamper one field while leaving the ORIGINAL integrity/digest in place — modelling an
 * attacker who edits the durable record but cannot forge its issue-time hash.
 */
export function seedIssued(request = sampleRequest(), { mutate, root = ws(), opts } = {}) {
  const record = makeIssueRecord(request, opts);
  if (mutate) mutate(record);
  writeStore(root, [issueLine(record)]);
  return { root, record };
}

/**
 * Seed a CRASH WINDOW: a valid issue line + a consume (tombstone) line, but NO receipt/outcome line —
 * exactly the durable state a process leaves if it dies after committing the consume but before (family
 * 3) or after (family 4) the action ran. A live `consumeAndExecute` can never produce this itself.
 */
export function seedCrashWindow(request = sampleRequest(), { decision = "approve", root = ws(), opts } = {}) {
  const record = makeIssueRecord(request, opts);
  writeStore(root, [
    issueLine(record),
    consumeLine(record.handle, decision, new Date().toISOString(), record.requestDigest),
  ]);
  return { root, record };
}

/**
 * Type-appropriate mutation of a single persisted field to a DIFFERENT valid-ish value. Used by the
 * field-mutation family + the meta-test so every field of the record schema is attacked generically.
 */
export function mutatedValue(field, current) {
  switch (field) {
    case "handle":
      return `${current ?? "h"}-tampered`;
    case "operation":
      return current === "Write" ? "Bash" : "Write";
    case "normalizedArgs":
      return { command: "rm -rf /" };
    case "targetResources":
      return ["cmd:rm", "/etc/passwd"];
    case "repoWorktreeIdentity":
      return "/repo/evil@main";
    case "requestDigest":
      return capabilityDigest(sampleRequest({ normalizedArgs: { command: "rm -rf /" } }));
    case "createdAt":
      return new Date(Date.now() - 60_000).toISOString();
    case "expiresAt":
      // Extend the TTL far into the future — a classic "keep this handle alive" tamper.
      return new Date(Date.now() + 60 * 60_000).toISOString();
    case "audience":
      return "runtime-B/session-Y";
    case "idempotency":
      // Downgrade to the most permissive class to try to unlock auto-retry.
      return "safe-retry";
    case "epoch":
      return "key-epoch-999";
    case "integrity":
      return "0".repeat(64);
    default:
      return `${current ?? ""}-mutated`;
  }
}

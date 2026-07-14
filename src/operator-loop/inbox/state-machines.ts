// Unified inbox — the three orthogonal state machines (I-02 / AIO-383).
//
// Per the I-01 domain spec: an inbox item's lifecycle is NOT one status but three independent
// columns, each its own small state machine with enumerated legal transitions and an optimistic
// version. They are orthogonal — an item can be `attention_state = surfaced` (a human re-opened it)
// while `action_state = failed` (its last reply attempt failed) at the same time, because the two
// columns move independently. "Reopen is a transition event, not a state": there is no `reopened`
// state; a reopen is simply a legal edge back into `surfaced` / `proposed`.
//
// Two design rulings the domain spec pins that this module encodes:
//   • A stale approval attempt is DISTINGUISHABLE from a denial: `action_state` carries both
//     `expired` (the approval window elapsed) and `denied` (the human said no) as distinct states.
//   • Optimistic concurrency: every successful transition bumps a per-machine `version`; a caller
//     that supplies a stale `expectedVersion` is rejected with a typed `OptimisticLockError` before
//     the transition is even checked for legality.
//
// Pure + dependency-free: no I/O, no cross-domain imports. The journal fold (read-model.ts) applies
// events through `applyTransition`, catching typed errors as fold warnings (never silently dropping);
// direct callers (and the state-machine tests) let the typed errors propagate.

// ── machine names ────────────────────────────────────────────────────────────────────────────────

export type MachineName = "attention_state" | "action_state" | "source_state";

// ── attention_state: does this item need the human's attention right now? ─────────────────────────

export type AttentionState =
  | "unseen"
  | "surfaced"
  | "acknowledged"
  | "snoozed"
  | "resolved"
  | "archived";

export const ATTENTION_INITIAL: AttentionState = "unseen";

export const ATTENTION_STATES: readonly AttentionState[] = [
  "unseen",
  "surfaced",
  "acknowledged",
  "snoozed",
  "resolved",
  "archived",
];

// from → legal next states. `resolved → surfaced` and `archived → surfaced` are the REOPEN edges
// (a reopen is a transition, not a distinct state).
export const ATTENTION_TRANSITIONS: Readonly<Record<AttentionState, readonly AttentionState[]>> = {
  unseen: ["surfaced"],
  surfaced: ["acknowledged", "snoozed", "resolved", "archived"],
  acknowledged: ["snoozed", "resolved", "archived"],
  snoozed: ["surfaced"],
  resolved: ["surfaced"], // reopen
  archived: ["surfaced"], // reopen
};

// ── action_state: is an agent/human action being taken on this item? ──────────────────────────────

export type ActionState =
  | "none"
  | "proposed"
  | "awaiting_approval"
  | "approved"
  | "denied"
  | "expired"
  | "executing"
  | "succeeded"
  | "failed"
  | "outcome_unknown";

export const ACTION_INITIAL: ActionState = "none";

export const ACTION_STATES: readonly ActionState[] = [
  "none",
  "proposed",
  "awaiting_approval",
  "approved",
  "denied",
  "expired",
  "executing",
  "succeeded",
  "failed",
  "outcome_unknown",
];

// `awaiting_approval → expired` (stale) is deliberately distinct from `awaiting_approval → denied`.
// `executing → outcome_unknown` is the "API succeeded but we never saw the ack" case; it can later
// resolve to `succeeded`/`failed` (a native receipt arrives) or be retried (`→ executing`) for an
// idempotency-class operation. `failed`/`denied`/`expired → proposed` are the re-propose edges.
export const ACTION_TRANSITIONS: Readonly<Record<ActionState, readonly ActionState[]>> = {
  none: ["proposed"],
  proposed: ["awaiting_approval", "none"], // submit for approval, or withdraw
  awaiting_approval: ["approved", "denied", "expired"],
  approved: ["executing", "expired"],
  denied: ["proposed"], // re-propose after a denial
  expired: ["proposed"], // re-propose after a stale window
  executing: ["succeeded", "failed", "outcome_unknown"],
  succeeded: [],
  failed: ["proposed"], // retry / reopen
  outcome_unknown: ["succeeded", "failed", "executing"], // receipt resolves it, or idempotent retry
};

// ── source_state: the per-source object lifecycle (email/message/thread on the origin) ────────────

export type SourceState = "active" | "updated" | "deleted" | "archived_remote";

export const SOURCE_INITIAL: SourceState = "active";

export const SOURCE_STATES: readonly SourceState[] = [
  "active",
  "updated",
  "deleted",
  "archived_remote",
];

export const SOURCE_TRANSITIONS: Readonly<Record<SourceState, readonly SourceState[]>> = {
  active: ["updated", "deleted", "archived_remote"],
  updated: ["updated", "deleted", "archived_remote"],
  archived_remote: ["active", "updated"], // un-archived remotely
  deleted: ["active"], // restored remotely (rare, but representable)
};

// ── machine registry ──────────────────────────────────────────────────────────────────────────────

export interface MachineDef {
  readonly name: MachineName;
  readonly initial: string;
  readonly states: readonly string[];
  readonly transitions: Readonly<Record<string, readonly string[]>>;
}

export const MACHINES: Readonly<Record<MachineName, MachineDef>> = {
  attention_state: {
    name: "attention_state",
    initial: ATTENTION_INITIAL,
    states: ATTENTION_STATES,
    transitions: ATTENTION_TRANSITIONS as Readonly<Record<string, readonly string[]>>,
  },
  action_state: {
    name: "action_state",
    initial: ACTION_INITIAL,
    states: ACTION_STATES,
    transitions: ACTION_TRANSITIONS as Readonly<Record<string, readonly string[]>>,
  },
  source_state: {
    name: "source_state",
    initial: SOURCE_INITIAL,
    states: SOURCE_STATES,
    transitions: SOURCE_TRANSITIONS as Readonly<Record<string, readonly string[]>>,
  },
};

// ── typed errors ──────────────────────────────────────────────────────────────────────────────────

export class UnknownStateError extends Error {
  readonly machine: MachineName;
  readonly state: string;
  constructor(machine: MachineName, state: string) {
    super(`inbox ${machine}: unknown state "${state}"`);
    this.name = "UnknownStateError";
    this.machine = machine;
    this.state = state;
  }
}

export class IllegalTransitionError extends Error {
  readonly machine: MachineName;
  readonly from: string;
  readonly to: string;
  constructor(machine: MachineName, from: string, to: string) {
    super(`inbox ${machine}: illegal transition ${from} → ${to}`);
    this.name = "IllegalTransitionError";
    this.machine = machine;
    this.from = from;
    this.to = to;
  }
}

export class OptimisticLockError extends Error {
  readonly machine: MachineName;
  readonly expected: number;
  readonly actual: number;
  constructor(machine: MachineName, expected: number, actual: number) {
    super(`inbox ${machine}: optimistic-lock mismatch (expected v${expected}, have v${actual})`);
    this.name = "OptimisticLockError";
    this.machine = machine;
    this.expected = expected;
    this.actual = actual;
  }
}

// ── the machine value + transition function ───────────────────────────────────────────────────────

/** A single machine's current state + its optimistic version (transitions applied so far). */
export interface MachineValue {
  state: string;
  version: number;
}

export function initialValue(machine: MachineName): MachineValue {
  return { state: MACHINES[machine].initial, version: 0 };
}

export function isKnownState(machine: MachineName, state: string): boolean {
  return MACHINES[machine].states.includes(state);
}

export function isLegalTransition(machine: MachineName, from: string, to: string): boolean {
  const next = MACHINES[machine].transitions[from];
  return Array.isArray(next) && next.includes(to);
}

export interface TransitionOptions {
  /** When supplied, the transition is rejected unless it equals the machine's current version. */
  expectedVersion?: number;
}

/**
 * Apply a transition to `current`, returning the new {state, version}. Throws (never mutates):
 *   • OptimisticLockError    — expectedVersion supplied and stale (checked FIRST, before legality)
 *   • UnknownStateError      — from/to not in the machine's vocabulary
 *   • IllegalTransitionError — the edge from→to is not enumerated as legal
 * Version increments by exactly one on success.
 */
export function applyTransition(
  machine: MachineName,
  current: MachineValue,
  to: string,
  opts: TransitionOptions = {}
): MachineValue {
  if (opts.expectedVersion !== undefined && opts.expectedVersion !== current.version) {
    throw new OptimisticLockError(machine, opts.expectedVersion, current.version);
  }
  if (!isKnownState(machine, current.state)) throw new UnknownStateError(machine, current.state);
  if (!isKnownState(machine, to)) throw new UnknownStateError(machine, to);
  if (!isLegalTransition(machine, current.state, to)) {
    throw new IllegalTransitionError(machine, current.state, to);
  }
  return { state: to, version: current.version + 1 };
}

// ── enumeration helpers (used by the state-machine tests to generate every legal/illegal edge) ─────

/** Every legal [from, to] edge of a machine. */
export function legalEdges(machine: MachineName): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const from of MACHINES[machine].states) {
    for (const to of MACHINES[machine].transitions[from] ?? []) out.push([from, to]);
  }
  return out;
}

/** Every [from, to] pair over known states that is NOT a legal edge (the illegal complement). */
export function illegalEdges(machine: MachineName): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const from of MACHINES[machine].states) {
    for (const to of MACHINES[machine].states) {
      if (!isLegalTransition(machine, from, to)) out.push([from, to]);
    }
  }
  return out;
}

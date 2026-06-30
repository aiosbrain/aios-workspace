// C7 continuity store: local-only unresolved actions that should carry into the next run.
// The store lives under .aios/loop so it inherits the same "never synced" boundary as manifests.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Exclusion } from "./sources/types.js";

export const CONTINUITY_ACTIONS_REL = ".aios/loop/continuity/actions.json";

export interface ContinuityActionSource {
  path: string;
  row?: string;
  tier?: string | string[];
}

export interface ContinuityAction {
  id: string;
  title: string;
  status?: string;
  tier?: string | string[];
  access?: string | string[];
  audience?: string | string[];
  createdAt?: string;
  updatedAt?: string;
  due?: string;
  cadence?: "daily" | "weekly" | "both" | string;
  source?: ContinuityActionSource;
}

export interface ContinuityReadResult {
  actions: ContinuityAction[];
  excluded: Exclusion[];
}

const CLOSED_STATUSES = new Set([
  "done",
  "closed",
  "complete",
  "completed",
  "cancelled",
  "canceled",
  "resolved",
]);

export function isOpenContinuityAction(action: ContinuityAction): boolean {
  const status = (action.status ?? "open").trim().toLowerCase();
  return !CLOSED_STATUSES.has(status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function tierField(value: unknown): string | string[] | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value;
  return undefined;
}

function sourceField(value: unknown): ContinuityActionSource | undefined {
  if (!isRecord(value)) return undefined;
  const sourcePath = stringField(value.path);
  if (!sourcePath) return undefined;
  const source: ContinuityActionSource = { path: sourcePath };
  const row = stringField(value.row);
  if (row) source.row = row;
  const tier = tierField(value.tier);
  if (tier) source.tier = tier;
  return source;
}

function normalizeAction(value: unknown): ContinuityAction | null {
  if (!isRecord(value)) return null;
  const id = stringField(value.id);
  const title = stringField(value.title) ?? stringField(value.summary);
  if (!id || !title) return null;
  const action: ContinuityAction = { id, title };
  const status = stringField(value.status);
  if (status) action.status = status;
  const tier = tierField(value.tier);
  if (tier) action.tier = tier;
  const access = tierField(value.access);
  if (access) action.access = access;
  const audience = tierField(value.audience);
  if (audience) action.audience = audience;
  const createdAt = stringField(value.createdAt);
  if (createdAt) action.createdAt = createdAt;
  const updatedAt = stringField(value.updatedAt);
  if (updatedAt) action.updatedAt = updatedAt;
  const due = stringField(value.due);
  if (due) action.due = due;
  const cadence = stringField(value.cadence);
  if (cadence) action.cadence = cadence;
  const source = sourceField(value.source);
  if (source) action.source = source;
  return action;
}

export function readContinuityActions(root: string): ContinuityReadResult {
  const rel = CONTINUITY_ACTIONS_REL;
  const abs = path.join(root, rel);
  const out: ContinuityReadResult = { actions: [], excluded: [] };
  if (!existsSync(abs)) return out;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(abs, "utf8"));
  } catch (e) {
    out.excluded.push({ ref: rel, reason: `continuity actions store is invalid JSON: ${(e as Error).message}` });
    return out;
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.actions)) {
    out.excluded.push({ ref: rel, reason: "continuity actions store must contain actions[]" });
    return out;
  }

  parsed.actions.forEach((item, index) => {
    const action = normalizeAction(item);
    if (!action) {
      out.excluded.push({ ref: `${rel}#actions[${index}]`, reason: "continuity action is missing id/title" });
      return;
    }
    if (isOpenContinuityAction(action)) out.actions.push(action);
  });

  return out;
}

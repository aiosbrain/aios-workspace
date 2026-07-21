import type { CostEmailCandidate } from "../../types/protocol";
import { parseUsd } from "./CostSettingsForm";

export interface InvoiceImportRow extends CostEmailCandidate {
  selected: boolean;
  amount: string;
}

export function rowsFromScan(candidates: CostEmailCandidate[]): InvoiceImportRow[] {
  return candidates.map((candidate) => ({
    ...candidate,
    selected: false,
    amount: candidate.amount_usd == null ? "" : String(candidate.amount_usd),
  }));
}

/**
 * Turn explicit owner selections into a narrow config patch. Unselected rows
 * are ignored, so scanning can never clear or replace unrelated config.
 */
export function buildInvoiceImportPatch(
  rows: InvoiceImportRow[],
  period: string
):
  | {
      patch: {
        subscriptions?: Record<string, number>;
        metered?: Record<string, Record<string, number>>;
      };
    }
  | { error: string } {
  const subscriptions: Record<string, number> = {};
  const meteredTotals: Record<string, number> = {};
  for (const row of rows.filter((candidate) => candidate.selected)) {
    const amount = parseUsd(row.amount);
    if (amount == null || Number.isNaN(amount)) {
      return { error: `Enter a valid USD amount for ${row.label}` };
    }
    if (row.kind === "subscription") {
      if (subscriptions[row.provider] != null) {
        return { error: `Select only one ${row.label} subscription charge for ${period}` };
      }
      subscriptions[row.provider] = amount;
    } else {
      meteredTotals[row.provider] = (meteredTotals[row.provider] ?? 0) + amount;
    }
  }
  if (!Object.keys(subscriptions).length && !Object.keys(meteredTotals).length) {
    return { error: "Select at least one invoice" };
  }
  const patch: {
    subscriptions?: Record<string, number>;
    metered?: Record<string, Record<string, number>>;
  } = {};
  if (Object.keys(subscriptions).length) patch.subscriptions = subscriptions;
  if (Object.keys(meteredTotals).length) {
    patch.metered = Object.fromEntries(
      Object.entries(meteredTotals).map(([provider, amount]) => [provider, { [period]: amount }])
    );
  }
  return { patch };
}

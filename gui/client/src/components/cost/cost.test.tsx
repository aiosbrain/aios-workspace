// Cost chart tests (AIO-457) — rendered with react-dom/server like comms.test.tsx
// (no jsdom): enough to pin the fixed-height/accessibility/actuals-only contract.

import { describe, test, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { CostBarChart, COST_CHART_H } from "./CostBarChart";
import {
  CostSettingsForm,
  buildConfigPatch,
  formFromConfig,
  parseUsd,
  type CostSettingsFormValues,
} from "./CostSettingsForm";
import { buildInvoiceImportPatch, rowsFromScan } from "./cost-email-import";
import type {
  CostConfigResponse,
  CostEmailCandidate,
  CostProviderActual,
} from "../../types/protocol";

const row = (
  provider: string,
  label: string,
  total_usd: number | null,
  status: CostProviderActual["status"] = total_usd == null ? "unknown" : "billing"
): CostProviderActual => ({ provider, label, status, total_usd, lines: total_usd == null ? 0 : 1 });

const TWO = [
  row("claude", "Claude", 200, "subscription"),
  row("anthropic", "Anthropic API", 42.13),
];
const FIVE = [
  ...TWO,
  row("cursor", "Cursor", 20, "config"),
  row("opencode", "Opencode", 3.25),
  row("codex", "Codex", null),
];

describe("CostBarChart", () => {
  test("height is fixed regardless of provider count", () => {
    const two = renderToStaticMarkup(<CostBarChart rows={TWO} period="2026-07" />);
    const five = renderToStaticMarkup(<CostBarChart rows={FIVE} period="2026-07" />);
    expect(two).toContain(`height="${COST_CHART_H}"`);
    expect(five).toContain(`height="${COST_CHART_H}"`);
    expect((two.match(/height="150"/g) ?? []).length).toBe(1);
    expect((five.match(/height="150"/g) ?? []).length).toBe(1);
  });

  test("has a labeled USD x-axis with tabular figures", () => {
    const html = renderToStaticMarkup(<CostBarChart rows={TWO} period="2026-07" />);
    expect(html).toContain("$0"); // axis origin tick
    expect(html).toMatch(/\$\d/); // dollar-denominated ticks
    expect(html).toContain("tabular-nums");
    expect(html).toContain("font-variant-numeric:tabular-nums");
  });

  test("exposes a full text equivalent and exact amounts", () => {
    const html = renderToStaticMarkup(<CostBarChart rows={FIVE} period="2026-07" />);
    expect(html).toContain('role="img"');
    expect(html).toContain("Actual spend by provider for 2026-07");
    expect(html).toContain("Claude $200.00");
    expect(html).toContain("Anthropic API $42.13");
    expect(html).toContain("Codex unknown");
    expect(html).toContain("$42.13"); // rendered amount label
  });

  test("never draws a bar for an unknown provider and never mentions tokens", () => {
    const html = renderToStaticMarkup(<CostBarChart rows={FIVE} period="2026-07" />);
    // 4 known providers → 4 bars (rects); codex (unknown) gets none.
    expect((html.match(/<rect/g) ?? []).length).toBe(4);
    expect(html.toLowerCase()).not.toContain("token");
    expect(html.toLowerCase()).not.toContain("estimate");
  });

  test("empty state is honest text, still at fixed height", () => {
    const html = renderToStaticMarkup(
      <CostBarChart rows={[row("codex", "Codex", null)]} period="2026-07" />
    );
    expect(html).toContain("No actual spend recorded for 2026-07.");
    expect(html).toContain(`height="${COST_CHART_H}"`);
  });
});

// ── Settings form: a failed config GET must never turn into a config wipe ──────────────────────────

const BLANK_FORM: CostSettingsFormValues = {
  claude: "",
  cursor: "",
  codex: "",
  opencode: "",
  zai: "",
  anthropic: "",
  openai: "",
  openrouter: "",
};

function renderForm(props: Partial<Parameters<typeof CostSettingsForm>[0]> = {}) {
  return renderToStaticMarkup(
    <CostSettingsForm
      period="2026-07"
      form={BLANK_FORM}
      loaded={false}
      loadError={null}
      status={null}
      busy={false}
      onChange={() => {}}
      onSave={() => {}}
      onRetry={() => {}}
      {...props}
    />
  );
}

describe("CostSettingsForm", () => {
  test("Save and inputs are disabled until the config GET has hydrated the form", () => {
    // Reviewer repro: GET failed → all-blank form. Saving it would post explicit
    // nulls and delete every existing entry, so everything must be disabled.
    const html = renderForm({ loaded: false, loadError: "http 500" });
    const saveBtn = html.slice(html.lastIndexOf("<button"));
    expect(saveBtn).toContain('disabled=""'); // the attribute, not the Tailwind variant
    expect((html.match(/<input[^>]*\sdisabled=""/g) ?? []).length).toBe(8);
    expect(html).toContain("editing is disabled so a save can’t wipe your existing entries");
    expect(html).toContain("Retry");
  });

  test("hydrated form is fully editable", () => {
    const html = renderForm({
      loaded: true,
      form: {
        claude: "200",
        cursor: "20",
        codex: "",
        opencode: "15",
        zai: "10",
        anthropic: "42.13",
        openai: "10",
        openrouter: "8.5",
      },
    });
    const saveBtn = html.slice(html.lastIndexOf("<button"));
    expect(saveBtn).not.toContain('disabled=""');
    expect((html.match(/<input[^>]*\sdisabled=""/g) ?? []).length).toBe(0);
    expect(html).toContain('value="42.13"');
  });
});

describe("config patch round-trip", () => {
  const CFG: CostConfigResponse = {
    ok: true,
    subscriptions: { claude: 200, cursor: null, codex: 0, opencode: 15, zai: 10 },
    metered: {
      anthropic: { "2026-07": 42.13 },
      cursor: {},
      codex: {},
      openai: { "2026-07": 10 },
      opencode: {},
      openrouter: { "2026-07": 8.5 },
      zai: {},
    },
  };

  test("formFromConfig displays exactly what the server resolved", () => {
    expect(formFromConfig(CFG, "2026-07")).toEqual({
      claude: "200",
      cursor: "",
      codex: "0",
      opencode: "15",
      zai: "10",
      anthropic: "42.13",
      openai: "10",
      openrouter: "8.5",
    });
  });

  test("buildConfigPatch preserves hydrated values and nulls only true blanks", () => {
    const built = buildConfigPatch(formFromConfig(CFG, "2026-07"), "2026-07");
    expect(built).toEqual({
      patch: {
        subscriptions: { claude: 200, cursor: null, codex: 0, opencode: 15, zai: 10 },
        metered: {
          anthropic: { "2026-07": 42.13 },
          openai: { "2026-07": 10 },
          openrouter: { "2026-07": 8.5 },
        },
      },
    });
  });

  test("buildConfigPatch rejects invalid amounts instead of posting them", () => {
    const built = buildConfigPatch({ ...BLANK_FORM, cursor: "lots" }, "2026-07");
    expect(built).toEqual({ error: '"lots" isn\'t a valid USD amount' });
    expect(parseUsd("$20")).toBe(20);
    expect(parseUsd("  ")).toBeNull();
    expect(Number.isNaN(parseUsd("-5") as number)).toBe(true);
  });
});

describe("invoice import patch", () => {
  const candidate = (
    id: string,
    provider: string,
    label: string,
    kind: CostEmailCandidate["kind"],
    amount_usd: number | null
  ): CostEmailCandidate => ({
    id,
    message_id: id,
    account: "owner@example.com",
    provider,
    label,
    kind,
    amount_usd,
    date: "2026-07-03",
    subject: `${label} receipt`,
    confidence: amount_usd == null ? "medium" : "high",
    reason: "verified provider sender",
  });

  test("scan rows are never selected automatically", () => {
    const rows = rowsFromScan([candidate("one", "cursor", "Cursor", "subscription", 20)]);
    expect(rows[0].selected).toBe(false);
    expect(rows[0].amount).toBe("20");
    expect(buildInvoiceImportPatch(rows, "2026-07")).toEqual({
      error: "Select at least one invoice",
    });
  });

  test("selected subscriptions stay singular and metered invoices are summed", () => {
    const rows = rowsFromScan([
      candidate("sub", "cursor", "Cursor", "subscription", 20),
      candidate("api-1", "openai", "OpenAI API", "metered", 10),
      candidate("api-2", "openai", "OpenAI API", "metered", 15),
    ]).map((row) => ({ ...row, selected: true }));
    expect(buildInvoiceImportPatch(rows, "2026-07")).toEqual({
      patch: {
        subscriptions: { cursor: 20 },
        metered: { openai: { "2026-07": 25 } },
      },
    });
  });

  test("ambiguous missing amounts and duplicate subscription receipts require owner correction", () => {
    const missing = rowsFromScan([candidate("one", "zai", "Z.ai", "subscription", null)]).map(
      (row) => ({ ...row, selected: true })
    );
    expect(buildInvoiceImportPatch(missing, "2026-07")).toEqual({
      error: "Enter a valid USD amount for Z.ai",
    });

    const duplicate = rowsFromScan([
      candidate("one", "cursor", "Cursor", "subscription", 20),
      candidate("two", "cursor", "Cursor", "subscription", 20),
    ]).map((row) => ({ ...row, selected: true }));
    expect(buildInvoiceImportPatch(duplicate, "2026-07")).toEqual({
      error: "Select only one Cursor subscription charge for 2026-07",
    });
  });
});

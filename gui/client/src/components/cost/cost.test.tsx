// Cost chart tests (AIO-457) — rendered with react-dom/server like comms.test.tsx
// (no jsdom): enough to pin the fixed-height/accessibility/actuals-only contract.

import { describe, test, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { CostBarChart, COST_CHART_H } from "./CostBarChart";
import type { CostProviderActual } from "../../types/protocol";

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

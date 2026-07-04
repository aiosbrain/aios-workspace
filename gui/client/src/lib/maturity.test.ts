import { describe, it, expect } from "vitest";
import { buildTrendSeries, yForScore, VIEW_W } from "./maturity";
import type { MaturityDay } from "../types/protocol";

const day = (date: string, am: number | null, ce: number | null): MaturityDay => ({ date, am, ce });

describe("buildTrendSeries", () => {
  it("splits CE into separate segments at a null day", () => {
    const days = [
      day("d1", 2, 1),
      day("d2", 2, 2),
      day("d3", 2, null), // gap
      day("d4", 2, 3),
      day("d5", 2, 4),
    ];
    const { ceSegments } = buildTrendSeries(days);
    expect(ceSegments.length).toBe(2);
    expect(ceSegments[0].length).toBe(2); // d1, d2
    expect(ceSegments[1].length).toBe(2); // d4, d5
    // No CE point lands at the null (d3) x-coordinate.
    const nullX = buildTrendSeries(days).am[2].x;
    for (const seg of ceSegments) {
      for (const p of seg) expect(p.x).not.toBe(nullX);
    }
  });

  it("scales 0–4: 4 → top (min y), 0 → bottom (max y), 2 → midpoint", () => {
    const top = yForScore(4);
    const bottom = yForScore(0);
    const mid = yForScore(2);
    expect(top).toBeLessThan(mid);
    expect(mid).toBeLessThan(bottom);
    expect(mid).toBeCloseTo((top + bottom) / 2, 6);
  });

  it("returns empty series for empty input, no throw", () => {
    const s = buildTrendSeries([]);
    expect(s.am).toEqual([]);
    expect(s.ceSegments).toEqual([]);
    expect(s.width).toBe(VIEW_W);
  });

  it("keeps AM continuous even when CE has gaps", () => {
    const days = [day("d1", 1, null), day("d2", 2, 3), day("d3", 3, null)];
    const { am, ceSegments } = buildTrendSeries(days);
    expect(am.length).toBe(days.length);
    expect(ceSegments.length).toBe(1);
    expect(ceSegments[0].length).toBe(1);
  });
});

/**
 * maturity.ts — pure geometry for the cockpit's hand-rolled 30-day AM-vs-CE trend.
 *
 * Maps a `MaturityDay[]` into SVG points on a fixed 0–4 scale. AM (placement.overall)
 * is always numeric, so it renders as one continuous polyline. CE is a SHADOW band that
 * is `null` on uncalibrated days — those days must show as GAPS (no interpolation), so
 * CE is returned as an array of contiguous segments split at every null.
 *
 * Zero dependencies; no DOM. Kept separate from MaturityPanel so it is unit-testable.
 */

import type { MaturityDay } from "../types/protocol";

export interface Point {
  x: number;
  y: number;
}
export interface TrendSeries {
  width: number;
  height: number;
  /** 0–4 grid line y-coordinates, from 4 (top) down to 0 (bottom). */
  gridY: number[];
  am: Point[];
  ceSegments: Point[][];
}

// Fixed viewBox geometry — the panel renders `<svg viewBox="0 0 VIEW_W VIEW_H">`.
export const VIEW_W = 600;
export const VIEW_H = 120;
const PAD_TOP = 8;
const PAD_BOTTOM = 8;
const PAD_LEFT = 24; // room for the 0–4 y-axis labels
const PAD_RIGHT = 8;
const SCALE_MAX = 4;

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** Map a day index → x across the plot width (single day sits at the left edge). */
function xAt(i: number, count: number): number {
  const plotW = VIEW_W - PAD_LEFT - PAD_RIGHT;
  if (count <= 1) return PAD_LEFT;
  return PAD_LEFT + (i / (count - 1)) * plotW;
}

/** Map a 0–4 score → y (0 → bottom, 4 → top). */
export function yForScore(score: number): number {
  const plotH = VIEW_H - PAD_TOP - PAD_BOTTOM;
  return PAD_TOP + (1 - clamp(score, 0, SCALE_MAX) / SCALE_MAX) * plotH;
}

export function buildTrendSeries(days: MaturityDay[]): TrendSeries {
  const gridY = [4, 3, 2, 1, 0].map(yForScore);
  const count = days.length;

  const am: Point[] = [];
  const ceSegments: Point[][] = [];
  let current: Point[] | null = null;

  days.forEach((d, i) => {
    const x = xAt(i, count);
    if (typeof d.am === "number") am.push({ x, y: yForScore(d.am) });
    // CE: break the line at every null day (no interpolation across a gap).
    if (typeof d.ce === "number") {
      if (!current) {
        current = [];
        ceSegments.push(current);
      }
      current.push({ x, y: yForScore(d.ce) });
    } else {
      current = null;
    }
  });

  return { width: VIEW_W, height: VIEW_H, gridY, am, ceSegments };
}

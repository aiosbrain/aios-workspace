import { Text } from "ink";
import { terminalTheme } from "./theme.js";
import { renderStatic, safeText } from "./static.js";
import { splitGraphemes, terminalWidth } from "./vendor/lib/terminal-text.js";
import type { Capabilities, Tone } from "./types.js";

/**
 * Line composer for static reports (analyze, context-health, codebase-health).
 *
 * Reports are laid out here, not by Ink's flex wrapping, so alignment is exact and
 * wrapping is deterministic: prose breaks only at spaces; a single token wider than
 * its column (a long path, a model id) breaks after a separator such as "/" or "_"
 * and is hard-split only when it has none. Every line is at most ctx.width cells.
 * Ink then renders each pre-wrapped line with the shared AIOS theme.
 */
export interface Seg {
  text: string;
  tone?: Tone;
  bold?: boolean;
  /** Never break inside this segment (a command such as `aios update`) unless it is wider than a line. */
  keep?: boolean;
}
export type Line = Seg[];
export type FieldValue = Line | { prefix: Line; body: Line } | { block: Line[] };

const UNICODE = {
  full: "█",
  empty: "░",
  none: "·",
  arrow: "→",
  pass: "✓",
  fail: "✗",
  soft: "•",
  skip: "·",
  bullet: "•",
  rule: "─",
  spark: ["▁", "▂", "▄", "▆", "█"],
};
const ASCII: typeof UNICODE = {
  full: "#",
  empty: "-",
  none: ".",
  arrow: "->",
  pass: "+",
  fail: "x",
  soft: "!",
  skip: "-",
  bullet: "*",
  rule: "-",
  spark: ["0", "1", "2", "3", "4"],
};
// AIOS_UI_GLYPHS=ascii also transliterates punctuation inside report copy, before
// layout, so measured widths stay exact.
const TRANSLIT: [RegExp, string][] = [
  [/[—–]/g, "-"],
  [/→/g, "->"],
  [/↗/g, "^"],
  [/↘/g, "v"],
  [/·/g, "|"],
  [/×/g, "x"],
  [/…/g, "..."],
  [/≥/g, ">="],
  [/≤/g, "<="],
  [/[‘’]/g, "'"],
  [/[“”]/g, '"'],
];
// A token wider than its column may break after one of these.
const BREAK_AFTER = new Set([
  "/",
  "\\",
  "_",
  "-",
  ".",
  ";",
  ",",
  ":",
  "=",
  ">",
  "]",
  ")",
  "&",
  "?",
]);

export const width = (line: Line) => line.reduce((n, s) => n + terminalWidth(s.text), 0);
export const space = (n: number): Seg => ({ text: " ".repeat(Math.max(0, n)) });
export const padEnd = (line: Line, cells: number): Line => [...line, space(cells - width(line))];
export const padStart = (line: Line, cells: number): Line => [space(cells - width(line)), ...line];

/** Semantic tone for a 0–4 score: strong (≥3), developing (≥2), weak (<2); unscored is muted. */
export const scoreTone = (score: number | null | undefined): Tone =>
  score == null || !Number.isFinite(score)
    ? "muted"
    : score >= 3
      ? "success"
      : score >= 2
        ? "warning"
        : "error";

/**
 * Split a token wider than `room` after its last fitting separator, else hard. A break
 * never lands inside a run of separators ("__") and prefers any separator over ".", so
 * "alarm.md" stays whole when another break point fits.
 */
function splitToken(text: string, room: number): [string, string] {
  const graphemes = splitGraphemes(text);
  let used = 0;
  let fit = 0;
  let strong = 0;
  let weak = 0;
  for (const [i, g] of graphemes.entries()) {
    const w = terminalWidth(g);
    if (used + w > room) break;
    used += w;
    fit++;
    if (BREAK_AFTER.has(g) && !BREAK_AFTER.has(graphemes[i + 1] ?? "")) {
      if (g === ".") weak = fit;
      else strong = fit;
    }
  }
  const cut = strong || weak || Math.max(1, fit);
  return [graphemes.slice(0, cut).join(""), graphemes.slice(cut).join("")];
}

type Token = { gap: string } | { word: Seg[] };

/** Words are runs of non-space text, even when they span differently styled segments. */
function tokenize(line: Line): Token[] {
  const tokens: Token[] = [];
  let joinable = false;
  for (const s of line) {
    for (const part of s.keep ? [s.text] : s.text.split(/(\s+)/)) {
      if (!part) continue;
      if (/^\s+$/.test(part)) {
        // Consecutive whitespace (padding segments) accumulates into one gap.
        const last = tokens[tokens.length - 1];
        const gap = part.replace(/\s/g, " ");
        if (last && "gap" in last) last.gap += gap;
        else tokens.push({ gap });
        joinable = false;
      } else {
        const last = tokens[tokens.length - 1];
        if (joinable && last && "word" in last) last.word.push({ ...s, text: part });
        else tokens.push({ word: [{ ...s, text: part }] });
        joinable = true;
      }
    }
  }
  return tokens;
}

/** Greedy word wrap across styled segments; never exceeds `cells` per line. */
export function wrap(line: Line, cells: number): Line[] {
  const max = Math.max(1, cells);
  const out: Line[] = [[]];
  let used = 0;
  let gap = "";
  const push = (seg: Seg) => {
    out[out.length - 1]!.push(seg);
    used += terminalWidth(seg.text);
  };
  const newline = () => {
    out.push([]);
    used = 0;
  };
  for (const token of tokenize(line)) {
    if ("gap" in token) {
      gap = token.gap;
      continue;
    }
    const w = width(token.word);
    const lead = used > 0 ? terminalWidth(gap) : 0;
    if (used + lead + w <= max || w <= max) {
      if (used + lead + w > max) newline();
      else if (lead) push({ text: gap });
      token.word.forEach(push);
    } else {
      // Wider than a whole line: fill the current line if useful room remains, then
      // break after separators ("/", "_", "-", …), hard-splitting only as a last resort.
      if (used > 0 && max - used - lead < 8) newline();
      else if (lead) push({ text: gap });
      for (const piece of token.word) {
        let text = piece.text;
        while (text) {
          if (used >= max) newline();
          if (used + terminalWidth(text) <= max) {
            push({ ...piece, text });
            break;
          }
          const [head, rest] = splitToken(text, max - used);
          push({ ...piece, text: head });
          text = rest;
          newline();
        }
      }
    }
    gap = "";
  }
  return out.map(merge);
}

const sameStyle = (a: Seg, b: Seg) => a.tone === b.tone && Boolean(a.bold) === Boolean(b.bold);
/** Join neighbouring same-style segments; a space between two of them takes their style. */
function merge(line: Line): Line {
  const out: Line = [];
  for (let i = 0; i < line.length; i++) {
    const seg = line[i]!;
    const prev = out[out.length - 1];
    const next = line[i + 1];
    if (prev && !seg.tone && !seg.bold && /^ +$/.test(seg.text) && next && sameStyle(prev, next)) {
      prev.text += seg.text;
    } else if (prev && sameStyle(prev, seg)) {
      prev.text += seg.text;
    } else {
      out.push({ ...seg });
    }
  }
  return out;
}

/** `prefix` occupies a fixed-width column; `body` wraps beside it with a hanging indent. */
export function hang(prefix: Line, prefixCells: number, body: Line, cells: number): Line[] {
  const lines = wrap(body, Math.max(12, cells - prefixCells));
  return lines.map((l, i) => [
    ...(i === 0 ? padEnd(prefix, prefixCells) : [space(prefixCells)]),
    ...l,
  ]);
}

/** Cells available to a keyed value: beside the key column, or under it when narrow. */
const valueCells = (ctx: Capabilities, keyCells: number) =>
  ctx.width >= 80 ? ctx.width - keyCells : ctx.width - 2;

/**
 * A keyed block. Wide terminals align values in a column `keyCells` wide; below 80
 * columns the key stands alone and values stack beneath it with a two-cell indent.
 * A value is prose (wrapped), a `{ prefix, body }` pair (the body hangs after the
 * prefix, e.g. "1. "), or a `{ block }` of lines already sized to `valueCells`.
 */
function field(ctx: Capabilities, key: Line, values: FieldValue[], keyCells: number): Line[] {
  const cells = valueCells(ctx, keyCells);
  const inner = values.flatMap((v) =>
    Array.isArray(v)
      ? wrap(v, cells)
      : "block" in v
        ? v.block
        : hang(v.prefix, width(v.prefix), v.body, cells)
  );
  if (ctx.width >= 80) {
    return inner.map((line, i) => [...padEnd(i === 0 ? key : [], keyCells), ...line]);
  }
  return [key, ...inner.map((line) => [space(2), ...line])];
}

/** Prefix then body beside it when there is room (column >= `minCells`), else stacked. */
function lead(ctx: Capabilities, prefix: Line, body: Line, minCells = 0): Line[] {
  const cells = Math.max(minCells, width(prefix) + 2);
  if (ctx.width >= 80 && cells <= ctx.width / 2) return hang(prefix, cells, body, ctx.width);
  return [...wrap(prefix, ctx.width), ...hang([], 2, body, ctx.width)];
}

/** Render pre-wrapped lines with the shared AIOS theme; monochrome strips every SGR. */
function render(ctx: Capabilities, lines: Line[]) {
  const colors = terminalTheme(ctx).colors;
  const color = (tone?: Tone) =>
    tone === "heading"
      ? colors.primary
      : tone && tone !== "muted"
        ? colors[tone as "accent" | "info" | "success" | "warning" | "error"]
        : undefined;
  return renderStatic(
    ctx,
    <>
      {lines.map((line, i) => (
        <Text key={i}>
          {line.length === 0
            ? " "
            : line.map((seg, j) => (
                <Text
                  key={j}
                  color={color(seg.tone)}
                  dimColor={seg.tone === "muted"}
                  bold={seg.bold}
                >
                  {seg.text}
                </Text>
              ))}
        </Text>
      ))}
    </>
  );
}

export function kit(ctx: Capabilities) {
  const ascii = ctx.glyphs === "ascii";
  const G = ascii ? ASCII : UNICODE;
  const clean = (value: unknown) => {
    let text = safeText(value);
    if (ascii) for (const [re, to] of TRANSLIT) text = text.replace(re, to);
    return text;
  };
  const s = (value: unknown, tone?: Tone, bold?: boolean): Seg => ({
    text: clean(value),
    tone,
    bold,
  });
  /** Prose whose `code` spans become bold lime commands (backticks dropped). */
  const prose = (value: unknown, tone?: Tone): Line => {
    const text = clean(value);
    const parts = text.split("`");
    if (parts.length % 2 === 0) return [{ text, tone }];
    return parts
      .map((part, i) =>
        i % 2
          ? { text: part, tone: "accent" as Tone, bold: true, keep: true }
          : { text: part, tone }
      )
      .filter((seg) => seg.text);
  };
  /** A proportional 0–4 bar `cells` wide; unscored renders as an empty dotted track. */
  const bar = (score: number | null, cells: number, tone: Tone = scoreTone(score)): Line => {
    if (score == null || !Number.isFinite(score))
      return [{ text: G.none.repeat(cells), tone: "muted" }];
    const filled = Math.max(0, Math.min(cells, Math.round((score / 4) * cells)));
    return [
      { text: G.full.repeat(filled), tone },
      { text: G.empty.repeat(cells - filled), tone: "muted" },
    ];
  };
  /** Heading: the AIOS product label stays terminal-native; the command name is violet. */
  const title = (command: string): Line => [
    { text: "AIOS", bold: true },
    { text: ` ${ascii ? "|" : "·"} ${command}`, tone: "heading", bold: true },
  ];
  return {
    G,
    ascii,
    cells: ctx.width,
    s,
    prose,
    bar,
    title,
    field: (key: Line, values: FieldValue[], keyCells: number) => field(ctx, key, values, keyCells),
    valueCells: (keyCells: number) => valueCells(ctx, keyCells),
    lead: (prefix: Line, body: Line, minCells?: number) => lead(ctx, prefix, body, minCells),
    render: (lines: Line[]) => render(ctx, lines),
    wrap,
    hang,
  };
}

import { kit, padEnd, padStart, scoreTone, space, width, type Line } from "./compose.js";
import type { AnalyzeView, Capabilities, CostRow, Tone } from "./types.js";

// Axis labels top out at 22 cells ("Learning / compounding"); every keyed block shares
// that column so axes, cards, coaching and next steps line up down the whole report.
const KEY = 24;

type Kit = ReturnType<typeof kit>;

export function renderAnalyze(ctx: Capabilities, view: AnalyzeView) {
  const k = kit(ctx);
  const keyCells = ctx.width >= 80 ? KEY : 0;
  const L: Line[] = [
    ...header(k, view),
    [],
    ...axes(k, view),
    ...(view.trend ? [[], ...trend(k, view.trend, keyCells)] : []),
    [],
    ...cards(k, view, keyCells),
    [],
    ...coaching(k, view, keyCells),
  ];
  if (view.cost) costBlock(view, k, L);
  if (view.deepDive) deepDive(view, k, L, keyCells);
  return k.render(L);
}

const sepOf = (k: Kit) => ` ${k.ascii ? "|" : "·"} `;
const keyOf = (k: Kit, text: string): Line => [k.s(text, "heading", true)];

/** Title, window and tools, totals, and the Spine placement. */
function header(k: Kit, view: AnalyzeView): Line[] {
  const { s, G } = k;
  const sep = sepOf(k);
  const w = k.cells;
  return [
    k.title("analyze"),
    ...k.wrap(
      [
        s(`${view.window.since} ${G.arrow} ${view.window.until}`),
        s(sep, "muted"),
        s(view.tools.join(", ")),
      ],
      w
    ),
    ...k.wrap(
      [
        s(view.totals.sessions, undefined, true),
        s(" sessions"),
        s(sep, "muted"),
        s(view.totals.tasks, undefined, true),
        s(" tasks"),
        s(sep, "muted"),
        s(view.totals.tokens, undefined, true),
        s(" tokens"),
      ],
      w
    ),
    [],
    ...k.wrap(
      [
        s("You're at "),
        s(`Spine ${view.spine.level}`, "heading", true),
        s(" — "),
        s(view.spine.gloss),
      ],
      w
    ),
    ...k.wrap(
      [
        s("overall ", "muted"),
        s(`${view.spine.overallText}/4`, scoreTone(view.spine.overall), true),
        s(`${sep}each axis scored 0–4`, "muted"),
      ],
      w
    ),
  ];
}

/** Axes: label · proportional bar · score · gloss (wrapping in its own column). */
function axes(k: Kit, view: AnalyzeView): Line[] {
  const { s, bar } = k;
  const wide = k.cells >= 80;
  const labelCells = wide ? KEY : 23;
  const scoreCells = k.ascii ? 8 : 7;
  // Below ~40 columns even the narrow row cannot fit: the label stands alone and the bar
  // shrinks (never below 4 cells) so bar and score share the next line.
  const inline = wide || labelCells + 8 + 2 + scoreCells <= k.cells;
  const barCells =
    k.cells >= 100
      ? 20
      : wide
        ? 12
        : inline
          ? 8
          : Math.max(4, Math.min(8, k.cells - 4 - scoreCells));
  const glossAt = wide ? labelCells + barCells + 2 + scoreCells : 2;
  const L: Line[] = [];
  const row = (label: string, track: Line, score: Line, gloss: Line, note: Line | null) => {
    const meter: Line = [...track, space(2), ...padEnd(score, scoreCells)];
    if (wide)
      L.push(...k.hang([...padEnd([s(label)], labelCells), ...meter], glossAt, gloss, k.cells));
    else if (inline)
      L.push([...padEnd([s(label)], labelCells), ...meter], ...k.hang([], 2, gloss, k.cells));
    else
      L.push(
        ...k.wrap([s(label)], k.cells),
        [space(2), ...meter],
        ...k.hang([], 2, gloss, k.cells)
      );
    if (note) L.push(...k.hang([], glossAt, note, k.cells));
  };
  for (const axis of view.axes) {
    row(
      axis.label,
      bar(axis.score, barCells),
      [s(axis.scoreText, scoreTone(axis.score), true)],
      [s(axis.gloss)],
      axis.note ? [s(axis.note, "muted")] : null
    );
  }
  const ce = view.ergonomics;
  row(
    ce.label,
    bar(ce.band, barCells, "info"),
    ce.band == null
      ? [s("–", "muted")]
      : [s(`${ce.band}/4`, "info", true), s(` ${ce.trend ?? ""}`, "info")],
    [s(`(${ce.note})`, "info")],
    null
  );
  return L;
}

/** Trend sparklines: one glyph per day, maturity toned by that day's score. */
function trend(k: Kit, t: NonNullable<AnalyzeView["trend"]>, keyCells: number): Line[] {
  const { s, G } = k;
  const gapGlyph = k.cells >= 80 ? " " : "";
  const row = (
    name: string,
    levels: (number | null)[],
    toneFor: (v: number) => Tone,
    label: string
  ): Line => {
    const cells: Line = [];
    levels.forEach((v, i) => {
      if (i) cells.push(s(gapGlyph));
      cells.push(v == null ? s(G.none, "muted") : s(G.spark[v], toneFor(v)));
    });
    return [s(`${name} `, "muted", true), ...cells, s(`  ${label}`, "muted")];
  };
  return k.field(
    keyOf(k, `${t.days}-day trend`),
    [
      row("AM", t.am, (v) => scoreTone(v), "maturity"),
      row("CE", t.ce, () => "info", "ergonomics shadow"),
      [s(`${G.none} = no data`, "muted")],
    ],
    keyCells
  );
}

/** Attention, context health and codebase health cards. */
function cards(k: Kit, view: AnalyzeView, keyCells: number): Line[] {
  const { s, G } = k;
  const L = k.field(
    keyOf(k, "Attention"),
    [
      [s(view.attention.reading, "info")],
      ...metricGrid(view.attention.metrics, k.valueCells(keyCells), s),
    ],
    keyCells
  );
  if (view.contextHealth) {
    const ch = view.contextHealth;
    L.push(
      ...k.field(
        keyOf(k, "Context health"),
        [
          [s(`${ch.score}/4`, scoreTone(ch.score), true), space(2), s(ch.reading)],
          ...ch.failing.map((f) => ({
            prefix: [
              f.kind === "hard" ? s(G.fail, "error", true) : s(G.soft, "warning", true),
              space(1),
            ],
            body: [s(f.label)],
          })),
        ],
        keyCells
      )
    );
  }
  if (view.codebaseHealth) {
    const cb = view.codebaseHealth;
    const values: Line[] = [[s(cb.status, statusTone(cb.status), true), space(2), s(cb.reading)]];
    if (cb.tip) values.push(k.prose(cb.tip, "muted"));
    L.push(...k.field(keyOf(k, "Codebase health"), values, keyCells));
  }
  return L;
}

/** Biggest opportunity, the ergonomics tip, and the next commands. */
function coaching(k: Kit, view: AnalyzeView, keyCells: number): Line[] {
  const { s, prose } = k;
  const op = view.opportunity;
  const L = k.field(
    keyOf(k, "Biggest opportunity"),
    [[s(op.label, "warning", true), s(" — "), s(op.gloss)], prose(op.step)],
    keyCells
  );
  if (view.ergonomicsTip) {
    L.push(
      ...k.field(
        keyOf(k, "Cognitive ergonomics"),
        [[s("(shadow) ", "info"), ...prose(view.ergonomicsTip)]],
        keyCells
      )
    );
  }
  L.push(
    ...k.field(
      keyOf(k, "Next"),
      view.hints.map((h) => prose(h, "muted")),
      keyCells
    )
  );
  return L;
}

function statusTone(status: string): Tone {
  return status === "healthy" ? "success" : status === "degraded" ? "warning" : "error";
}

/** Label/value pairs in the widest column count (4, 2 or 1) that fits `cells`. */
function metricGrid(metrics: [string, string][], cells: number, s: Kit["s"]): Line[] {
  const items = metrics.map(([label, value]) => ({
    label: s(label, "muted"),
    value: s(value, undefined, true),
  }));
  const layout = (cols: number) => {
    const columns = Array.from({ length: cols }, (_, c) => items.filter((_, i) => i % cols === c));
    const lw = columns.map((col) => Math.max(...col.map((it) => width([it.label]))));
    const vw = columns.map((col) => Math.max(...col.map((it) => width([it.value]))));
    const total = lw.reduce((n, w, c) => n + w + 1 + vw[c]!, 0) + 4 * (cols - 1);
    return { cols, lw, vw, total };
  };
  const fit = [4, 2, 1].map(layout).find((l) => l.total <= cells) ?? layout(1);
  const rows: Line[] = [];
  for (let r = 0; r < Math.ceil(items.length / fit.cols); r++) {
    const line: Line = [];
    for (let c = 0; c < fit.cols; c++) {
      const it = items[r * fit.cols + c];
      if (!it) break;
      if (c) line.push(space(4));
      line.push(...padEnd([it.label], fit.lw[c]!), space(1), ...padStart([it.value], fit.vw[c]!));
    }
    rows.push(line);
  }
  return rows;
}

function costBlock(view: AnalyzeView, k: Kit, L: Line[]) {
  const cost = view.cost!;
  const { s } = k;
  const rows = [...cost.real, ...cost.estimates].filter((r) => r.label);
  const lw = Math.max(...rows.map((r) => width([s(r.label)])), 0);
  const aw = Math.max(...rows.map((r) => width([s(r.amount)])), 0);
  const tableCells = 2 + lw + 3 + aw + 3 + Math.max(...rows.map((r) => width([s(r.basis)])), 0);
  const inline = tableCells <= k.cells;
  const costRow = (r: CostRow, amountTone: Tone | undefined) => {
    if (r.note) {
      L.push(...k.hang([], 4, [s(r.note, r.tone)], k.cells));
      return;
    }
    const amount = s(r.amount, r.tone ?? amountTone, !r.tone);
    const basis = s(r.basis, r.tone === "warning" ? "warning" : "muted");
    if (inline) {
      L.push(
        ...k.hang(
          [space(2), ...padEnd([s(r.label)], lw), space(3), ...padStart([amount], aw), space(3)],
          2 + lw + 3 + aw + 3,
          [basis],
          k.cells
        )
      );
    } else {
      L.push(...k.hang([space(2)], 2, [s(r.label)], k.cells));
      L.push(...k.hang([space(4)], 4, [amount, space(2), basis], k.cells));
    }
  };
  L.push([]);
  L.push(
    ...k.wrap(
      [
        s("Provider spend", "heading", true),
        space(2),
        s(`${cost.window.since} ${k.G.arrow} ${cost.window.until}`, "muted"),
      ],
      k.cells
    )
  );
  L.push([s("Real spend", undefined, true)]);
  cost.real.forEach((r) => costRow(r, undefined));
  if (cost.estimates.length) {
    L.push(
      ...k.wrap(
        [s("API-equivalent value", "info", true), s(" (not billed on a subscription)", "muted")],
        k.cells
      )
    );
    cost.estimates.forEach((r) => costRow(r, "info"));
  }
  if (cost.note) L.push(...k.wrap([s("note: ", "muted"), s(cost.note, "muted")], k.cells));
  L.push(...k.wrap([s(cost.legend, "muted")], k.cells));
}

function deepDive(view: AnalyzeView, k: Kit, L: Line[], keyCells: number) {
  const d = view.deepDive!;
  const { s, prose, field } = k;
  const cells = k.cells;
  const key = (text: string): Line => [s(text, "heading", true)];
  const rule: Line = [s(k.G.rule.repeat(cells), "muted")];
  L.push([], rule);
  L.push(
    ...k.wrap(
      [
        s("Deep dive", "heading", true),
        s(" — ", "muted"),
        s(d.label, "warning", true),
        s("  your weakest axis, ", "muted"),
        s(`${d.scoreText}/4`, scoreTone(d.score), true),
      ],
      cells
    )
  );
  L.push(rule);
  L.push(...field(key("What it means"), [prose(d.meaning)], keyCells));
  L.push(...field(key("Why it matters"), [prose(d.why)], keyCells));
  L.push(...field(key("Where you are"), [prose(d.where)], keyCells));
  L.push(
    ...field(
      key("What to do next"),
      d.steps.map((step, i) => ({ prefix: [s(`${i + 1}. `, "accent", true)], body: prose(step) })),
      keyCells
    )
  );
  // Other axes: label · score · stat, the stat hanging in its own column when there is
  // room for it (>= 40 cells), else stacked under the label.
  const labelCells = Math.max(...d.others.map((o) => width([s(o.label)]))) + 2;
  const cellsForValue = k.valueCells(keyCells);
  const statAt = labelCells + 8;
  const others = d.others.flatMap((o) => {
    const head: Line = [
      ...padEnd([s(o.label)], labelCells),
      s(`${o.scoreText}/4`, scoreTone(o.score), true),
    ];
    if (cellsForValue - statAt >= 40) {
      return k.hang([...head, s(" — ", "muted")], statAt, [s(o.stat, "muted")], cellsForValue);
    }
    return [head, ...k.hang([], 2, [s(o.stat, "muted")], cellsForValue)];
  });
  L.push(...field(key("Your other axes"), [{ block: others }], keyCells));
  if (d.contextHealth) {
    const values: Line[] = [[s("(shadow) ", "info"), s(d.contextHealth.reading)]];
    if (d.contextHealth.tip) values.push(prose(d.contextHealth.tip));
    L.push(...field(key("Context health"), values, keyCells));
  }
}

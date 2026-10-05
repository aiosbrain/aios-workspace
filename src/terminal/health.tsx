import { kit, padEnd, scoreTone, space, width, type Line } from "./compose.js";
import type { Capabilities, CodebaseHealthView, ContextHealthView, Tone } from "./types.js";

const evidenceTone = (evidence: string): Tone => (evidence === "complete" ? "muted" : "warning");
const statusTone = (status: string): Tone =>
  status === "healthy" ? "success" : status === "degraded" ? "warning" : "error";

/** `aios context-health`: every check with its detail, the summary, and fix hints. */
export function renderContextHealth(ctx: Capabilities, view: ContextHealthView) {
  const k = kit(ctx);
  const { s, G } = k;
  const wide = ctx.width >= 80;
  const sep = ` ${k.ascii ? "|" : "·"} `;
  const mark = (ok: boolean, kind: string) =>
    ok
      ? s(G.pass, "success", true)
      : kind === "hard"
        ? s(G.fail, "error", true)
        : s(G.soft, "warning", true);
  const L: Line[] = [k.title("context health")];
  L.push(...k.wrap([s(view.target), s(sep, "muted"), s(`${view.mode} mode`, "muted")], ctx.width));
  L.push([]);
  // Wide: label column then detail column; the label column is capped at half the width.
  const labelCells = Math.min(
    Math.floor(ctx.width / 2),
    Math.max(0, ...view.checks.map((c) => width([s(c.label)]))) + 4
  );
  for (const chk of view.checks) {
    const head: Line = [mark(chk.ok, chk.kind), space(1), s(chk.label, undefined, !chk.ok)];
    if (wide && width(head) <= labelCells) {
      L.push(...k.hang(head, labelCells, [s(chk.detail, chk.ok ? "muted" : undefined)], ctx.width));
    } else {
      L.push(...k.wrap(head, ctx.width));
      L.push(...k.hang([], 2, [s(chk.detail, chk.ok ? "muted" : undefined)], ctx.width));
    }
  }
  L.push([]);
  L.push(
    ...k.lead(
      [
        s("Context health", "heading", true),
        space(2),
        s(`${view.score}/4`, scoreTone(view.score), true),
      ],
      [s(view.summary)]
    )
  );
  const failing = view.checks.filter((c) => !c.ok).slice(0, 3);
  if (failing.length) {
    L.push([], [s("Fix hints", "heading", true)]);
    const idCells = Math.max(...failing.map((c) => width([s(c.id)]))) + 4;
    for (const chk of failing) {
      const head: Line = [mark(false, chk.kind), space(1), s(chk.id, undefined, true)];
      if (wide) L.push(...k.hang(head, idCells, [s(chk.detail)], ctx.width));
      else L.push(head, ...k.hang([], 2, [s(chk.detail)], ctx.width));
    }
  }
  return k.render(L);
}

/** `aios codebase-health`: axis bands, every check, the summary, and next band moves. */
export function renderCodebaseHealth(ctx: Capabilities, view: CodebaseHealthView) {
  const k = kit(ctx);
  const { s, G } = k;
  const sep = ` ${k.ascii ? "|" : "·"} `;
  const L: Line[] = [
    k.title("codebase health"),
    ...k.wrap([s(view.target), s(sep, "muted"), s(`${view.mode} mode`, "muted")], ctx.width),
    [],
    ...axisRows(k, view.axes),
    [],
    ...view.checks.flatMap((chk) => checkRow(k, chk)),
    [],
    ...k.lead(
      [
        s("Codebase health", "heading", true),
        space(2),
        s(view.status, statusTone(view.status), true),
      ],
      [s(view.summary)]
    ),
  ];
  if (view.nextMoves.length) {
    L.push([], [s("Next band moves", "heading", true)]);
    for (const b of view.nextMoves.slice(0, 5)) {
      L.push(
        ...k.hang(
          [s(G.bullet, "accent"), space(1)],
          2,
          [
            s(`${b.axis}:`, undefined, true),
            s(` ${b.metric} ${b.current} `),
            s(`${G.arrow} ${b.neededValue}`, "accent", true),
            s(` lifts band ${b.currentBand} `, "muted"),
            s(`${G.arrow} ${b.neededBand}`, "accent", true),
          ],
          ctx.width
        )
      );
    }
  }
  return k.render(L);
}

type Kit = ReturnType<typeof kit>;

/** Axis label · proportional band bar · band · checks passed and evidence state. */
function axisRows(k: Kit, axes: CodebaseHealthView["axes"]): Line[] {
  const { s } = k;
  const wide = k.cells >= 80;
  const barCells = k.cells >= 100 ? 20 : wide ? 12 : 8;
  const labelCells = Math.max(...axes.map((a) => width([s(a.label)])), 0) + 2;
  const bodyAt = labelCells + barCells + 2 + 5;
  return axes.flatMap((a) => {
    const head: Line = [
      ...padEnd([s(a.label)], labelCells),
      ...k.bar(a.band, barCells),
      space(2),
      ...padEnd([a.band == null ? s("–", "muted") : s(`${a.band}/4`, scoreTone(a.band), true)], 5),
    ];
    const body: Line = [
      s(a.total ? `${a.passed}/${a.total} checks ok` : "no inputs", a.total ? undefined : "muted"),
      s("; evidence ", "muted"),
      s(a.evidence, evidenceTone(a.evidence)),
    ];
    return wide ? k.hang(head, bodyAt, body, k.cells) : [head, ...k.hang([], 2, body, k.cells)];
  });
}

/** One check: mark, title, [evidence, required], and its detail, hanging after the mark. */
function checkRow(k: Kit, chk: CodebaseHealthView["checks"][number]): Line[] {
  const { s, G } = k;
  const mark = chk.skipped
    ? s(G.skip, "warning", true)
    : chk.ok
      ? s(G.pass, "success", true)
      : s(G.fail, "error", true);
  const tag: Line = [s(" [", "muted"), s(chk.evidence, evidenceTone(chk.evidence))];
  if (chk.required) tag.push(s(", ", "muted"), s("required", "heading"));
  tag.push(s("] ", "muted"));
  return k.hang(
    [mark, space(1)],
    2,
    [
      s(chk.title, undefined, !chk.ok && !chk.skipped),
      ...tag,
      s("— ", "muted"),
      s(chk.detail, chk.skipped ? "muted" : undefined),
    ],
    k.cells
  );
}

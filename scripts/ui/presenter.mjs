import { resolveOutputContext } from "./output-context.mjs";

/** Capability checks precede imports: machine/plain paths never load React or Ink. */
export function canPresent({ mode = "human", stream = process.stdout, env = process.env } = {}) {
  const ctx = resolveOutputContext({ mode, stream, env });
  const ci = !["", "0", "false", "off", "no"].includes(String(env.CI ?? "").toLowerCase());
  return (
    mode === "human" && stream.isTTY === true && env.TERM !== "dumb" && !ci && ctx.tier !== "plain"
  );
}
export async function createPresenter({
  mode = "human",
  stdout = process.stdout,
  stderr = process.stderr,
  env = process.env,
} = {}) {
  if (!canPresent({ mode, stream: stdout, env })) return null;
  let reports, session;
  try {
    [reports, session] = await Promise.all([
      import("../../dist/terminal/report.js"),
      import("../../dist/terminal/session.js"),
    ]);
  } catch {
    // Missing build or unsupported renderer: fall back BEFORE any operation starts.
    return null;
  }
  const context = (stream) => resolveOutputContext({ mode, stream, env });
  const emit = (render, fallback, stream = stdout) => {
    let text;
    try {
      text = render(context(stream));
    } catch {
      text = fallback;
    }
    try {
      stream.write(`${text}\n`);
    } catch {
      /* display failure cannot change an operation result */
    }
  };
  return {
    message(message, status = "info") {
      emit((ctx) => reports.renderMessage(ctx, message, status), message);
    },
    step(message) {
      emit((ctx) => reports.renderStep(ctx, message), message);
    },
    status(report) {
      emit(
        (ctx) => reports.renderStatus(ctx, report),
        [
          `AIOS status — ${report.project} → ${report.destination}`,
          ...[
            ["New", report.fresh],
            ["Modified", report.modified],
            ["Held locally", report.held],
          ].flatMap(([label, items]) => [
            label,
            ...items.map((i) => `${i.rel}${i.reason ? ` — ${i.reason}` : ""}`),
          ]),
          `Clean: ${report.clean}`,
        ].join("\n")
      );
    },
    async prompt(question) {
      // Never retry a failed prompt or operation: an answer may already have been used.
      return session.prompt(context(stdout), question, stdout);
    },
    async run(event, operation) {
      const ctx = context(stderr);
      let progress;
      try {
        if (canPresent({ mode, stream: stderr, env }) && ctx.motion && ctx.tier === "rich")
          progress = session.startProgress(ctx, event, stderr);
        else emit((c) => reports.renderMessage(c, event.label, "pending"), event.label, stderr);
      } catch {
        /* presentation must not affect operation count */
      }
      try {
        return await operation();
      } finally {
        try {
          progress?.stop();
        } catch {
          /* teardown only */
        }
      }
    },
  };
}

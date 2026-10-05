import path from "node:path";
import { pathToFileURL } from "node:url";
import { ensureTerminalBuilt, PACKAGE_ROOT } from "../ensure-terminal-built.mjs";
import { resolveOutputContext } from "./output-context.mjs";

const off = (value) => ["", "0", "false", "off", "no"].includes(String(value ?? "").toLowerCase());
const ensured = new Map();
const hinted = new WeakSet();

/**
 * Source checkouts compile src/terminal on demand (one content-hash check per process,
 * reached only after canPresent() accepted a human TTY). Installed packages short-circuit
 * on a single existsSync. Never throws. When an older build exists, waiting on another
 * command's build is capped so the CLI never looks hung; the older build renders.
 */
function ensureBuilt(root, notice) {
  if (!ensured.has(root))
    ensured.set(
      root,
      ensureTerminalBuilt(root, {
        onBuild: () => notice("aios: building the colour UI…"),
        onWait: () => notice("aios: waiting for another colour UI build…"),
        waitWhenBuiltMs: STALE_WAIT_MS,
      })
    );
  return ensured.get(root);
}

const STALE_WAIT_MS = 1_500;
const REBUILD = "run `npm run build:terminal`";

/** Name the remedy that can actually work for this state. */
function fallbackHint(build) {
  if (build.state === "no-compiler")
    return "aios: colour UI not built — install devDependencies (`npm install`), then " + REBUILD;
  return `aios: colour UI not built — ${REBUILD}`;
}

/** The only diagnostic the plain fallback may print: once, to a human TTY stderr. */
function hint(stderr, env, text) {
  if (hinted.has(stderr) || stderr?.isTTY !== true || !off(env.CI)) return;
  if (env.NO_COLOR || env.AIOS_UI_TIER === "plain" || env.TERM === "dumb") return;
  hinted.add(stderr);
  try {
    stderr.write(`${text}\n`);
  } catch {
    /* a hint must never change an operation result */
  }
}

/**
 * Bring dist/terminal up to date (source checkouts only) and import it. Returns null —
 * after one stderr hint — when the colour UI cannot load. Never throws.
 */
async function loadTerminalModules({ root, stderr, env }) {
  const build = ensureBuilt(root, (text) => {
    if (stderr?.isTTY !== true) return;
    try {
      stderr.write(`${text}\n`);
    } catch {
      /* notice only */
    }
  });
  let modules;
  try {
    const dist = (file) => pathToFileURL(path.join(root, "dist", "terminal", file)).href;
    const [reports, session] = await Promise.all([
      import(dist("report.js")),
      import(dist("session.js")),
    ]);
    modules = { reports, session };
  } catch {
    // Missing build or unsupported renderer: fall back BEFORE any operation starts,
    // and say so once — a silently plain checkout is the bug this replaced.
    hint(stderr, env, fallbackHint(build));
    return null;
  }
  // Only promise "the previous build" once it has actually loaded.
  if (build.ok === false && build.built)
    hint(
      stderr,
      env,
      build.reason === "lock-busy"
        ? "aios: colour UI is being rebuilt by another command — showing the previous build"
        : `aios: colour UI is out of date (rebuild failed) — ${REBUILD}`
    );
  return modules;
}

/** Capability checks precede imports: machine/plain paths never load React or Ink. */
export function canPresent({ mode = "human", stream = process.stdout, env = process.env } = {}) {
  const ctx = resolveOutputContext({ mode, stream, env });
  const ci = !off(env.CI);
  return (
    mode === "human" && stream.isTTY === true && env.TERM !== "dumb" && !ci && ctx.tier !== "plain"
  );
}
export async function createPresenter({
  mode = "human",
  stdout = process.stdout,
  stderr = process.stderr,
  env = process.env,
  root = PACKAGE_ROOT,
} = {}) {
  if (!canPresent({ mode, stream: stdout, env })) return null;
  const modules = await loadTerminalModules({ root, stderr, env });
  if (!modules) return null;
  const { reports, session } = modules;
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
    ...staticReports(reports, emit),
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

/**
 * Static report methods (analyze, context-health, codebase-health). `fallback` is the
 * command's own plain text, printed unchanged if the colour render fails, so a display
 * problem never hides a reading.
 */
function staticReports(reports, emit) {
  return {
    analyze: (view, fallback) => emit((ctx) => reports.renderAnalyze(ctx, view), fallback),
    contextHealth: (view, fallback) =>
      emit((ctx) => reports.renderContextHealth(ctx, view), fallback),
    codebaseHealth: (view, fallback) =>
      emit((ctx) => reports.renderCodebaseHealth(ctx, view), fallback),
  };
}

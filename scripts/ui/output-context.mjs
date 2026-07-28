/**
 * ui/output-context.mjs — terminal capability resolution for the AIOS CLI (GRAIN W0-4).
 *
 * Until now the CLI's entire visual identity was six lines of unconditional ANSI in
 * `scripts/cli-common.mjs`. It emitted escape codes into pipes, into files, into CI logs
 * and under `NO_COLOR` alike, because it referenced no environment and no stream. This
 * module is the capability layer that fixes that, and `cli-common.mjs`'s `c` is its first
 * consumer.
 *
 * ## The rules that shaped this module
 *
 * **1. `mode` is supplied, never sniffed.** 30+ scripts accept `--json`/`--porcelain`,
 * several with their own local flag branches, and commands are also invoked
 * programmatically and nested inside one another. A capability module that read
 * `process.argv` would misclassify every one of those. So `mode` is an *argument*,
 * passed in by the command that already parsed its own flags. There is deliberately no
 * argv access anywhere in this file.
 *
 * **2. Capabilities are per-stream and resolved lazily, never frozen at import.** A piped
 * stdout with a TTY stderr is the normal shape of `aios … | tee` and progress on stderr
 * must stay coloured in it. Freezing at import time would also make the CLI untestable,
 * because a test that mutates `process.env` after the first import would see a stale
 * answer. Resolution happens on use and is memoised per
 * `(stream, isTTY, columns, env-snapshot)`, so a changed stream capability or env yields
 * a new key rather than a stale hit.
 *
 * **3. No async probes.** No OSC 11 background query, no `CSI ?2026$p` synchronised-update
 * query. Both cost a terminal round trip on a CLI whose pitch includes being fast and
 * offline at import time, and the failure mode of guessing wrong here is a slightly
 * mismatched shade, not corruption.
 *
 * **4. `mode !== "human"` is null-decoration by construction.** Machine purity does not
 * depend on call sites remembering to decline to call `c` — a JSON or porcelain context
 * reports colour depth 0, motion off and ASCII glyphs no matter what the terminal can do.
 *
 * ## Detection order (per stream, highest precedence first)
 *
 *   explicit `colorDepth` option → `FORCE_COLOR` → `NO_COLOR` (present *and* non-empty)
 *   → `CLICOLOR_FORCE` → `CLICOLOR=0` → `TERM=dumb` → `isTTY` → `COLORTERM`/`TERM`
 *
 * `NO_COLOR=` (empty) does **not** disable colour: the no-color.org spec says the variable
 * must be "present and not an empty string". `CI` appears nowhere in the colour order: CI
 * stdout is a pipe, so `isTTY` already resolves it to 0, and a CI job that genuinely wants
 * colour sets `FORCE_COLOR`. It is read only to suppress **motion**, where being a
 * scrolling log file rather than a pipe is what matters.
 *
 * ## Escape hatches (demos, tests, screenshots)
 *
 * `AIOS_UI_TIER` · `AIOS_UI_MOTION` · `AIOS_UI_GLYPHS` · `AIOS_UI_WIDTH` · `AIOS_UI_BG`.
 *
 * Zero npm dependencies, Node built-ins only.
 */

/** Colour depth in bits. 4 = the 16 ANSI colours the CLI has always used. */
export const COLOR_DEPTH = Object.freeze({ NONE: 0, ANSI16: 4, ANSI256: 8, TRUECOLOR: 24 });

/** Output modes. Only `human` may decorate; the other two are machine channels. */
export const MODES = Object.freeze(["human", "json", "porcelain"]);

/**
 * Capability tiers. `basic` is "rich minus motion" — NOT "rich minus truecolour". Colour
 * depth is a separate scalar precisely so a 16-colour TTY still gets progress and a
 * `FORCE_COLOR` CI run still gets colour.
 */
export const TIERS = Object.freeze(["rich", "basic", "plain"]);

/**
 * Glyph sets. Not detectable: font coverage is invisible to the process, so this is a
 * preference with a conservative default, never a probe.
 */
export const GLYPH_SETS = Object.freeze(["nerd", "unicode", "ascii"]);

/** Fallback terminal width when the stream reports none (not a TTY, or `columns` is 0). */
export const DEFAULT_WIDTH = 80;

/**
 * Every environment variable this module reads. It is also the memoisation key: a change
 * to any of these invalidates a cached context, and a change to anything else cannot
 * affect the answer. Keeping the list in one place is what makes that claim checkable.
 */
export const ENV_KEYS = Object.freeze([
  "FORCE_COLOR",
  "NO_COLOR",
  "CLICOLOR",
  "CLICOLOR_FORCE",
  "TERM",
  "COLORTERM",
  "CI",
  "AIOS_UI_TIER",
  "AIOS_UI_MOTION",
  "AIOS_UI_GLYPHS",
  "AIOS_UI_WIDTH",
  "AIOS_UI_BG",
]);

/** `NO_COLOR` disables only when present AND non-empty (no-color.org). */
function noColorSet(env) {
  return typeof env.NO_COLOR === "string" && env.NO_COLOR !== "";
}

/** Truthy for env flags: absent → false; "0"/"false"/"off"/"no"/"" → false; else true. */
function envFlag(value) {
  if (value === undefined || value === null) return false;
  const v = String(value).trim().toLowerCase();
  if (v === "") return false;
  return !["0", "false", "off", "no"].includes(v);
}

/** Depth a colour-capable terminal gets, from `COLORTERM`/`TERM`. Never returns 0. */
function terminalDepth(env) {
  const colorterm = String(env.COLORTERM ?? "").toLowerCase();
  if (colorterm === "truecolor" || colorterm === "24bit") return COLOR_DEPTH.TRUECOLOR;
  const term = String(env.TERM ?? "").toLowerCase();
  if (term.includes("truecolor") || term.includes("direct")) return COLOR_DEPTH.TRUECOLOR;
  if (term.includes("256")) return COLOR_DEPTH.ANSI256;
  return COLOR_DEPTH.ANSI16;
}

/**
 * `FORCE_COLOR` per the de-facto convention: `0`/`false` disables; `1`, `true` and the
 * empty string mean "colour on" (16); `2` means 256; `3` means truecolour. Returns
 * `undefined` when the variable is absent, so the caller falls through to the next rule.
 */
function forceColorDepth(env) {
  if (!("FORCE_COLOR" in env) || env.FORCE_COLOR === undefined || env.FORCE_COLOR === null) {
    return undefined;
  }
  const raw = String(env.FORCE_COLOR).trim().toLowerCase();
  if (raw === "0" || raw === "false") return COLOR_DEPTH.NONE;
  if (raw === "" || raw === "true" || raw === "1") return COLOR_DEPTH.ANSI16;
  if (raw === "2") return COLOR_DEPTH.ANSI256;
  if (raw === "3") return COLOR_DEPTH.TRUECOLOR;
  // Anything else is a value we don't recognise; treat it as a plain opt-in rather than
  // silently disabling colour on a user who clearly asked for it.
  return COLOR_DEPTH.ANSI16;
}

/** Resolve colour depth for one stream. See the detection order in the module header. */
function resolveColorDepth(stream, env, explicit) {
  if (explicit !== undefined && explicit !== null) return normaliseDepth(explicit);

  const forced = forceColorDepth(env);
  if (forced !== undefined) return forced;

  if (noColorSet(env)) return COLOR_DEPTH.NONE;

  if (envFlag(env.CLICOLOR_FORCE)) return terminalDepth(env);
  if ("CLICOLOR" in env && !envFlag(env.CLICOLOR)) return COLOR_DEPTH.NONE;

  if (String(env.TERM ?? "").toLowerCase() === "dumb") return COLOR_DEPTH.NONE;

  if (!stream || stream.isTTY !== true) return COLOR_DEPTH.NONE;

  return terminalDepth(env);
}

/** Clamp an arbitrary caller-supplied depth onto the four supported rungs. */
function normaliseDepth(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return COLOR_DEPTH.NONE;
  if (n >= COLOR_DEPTH.TRUECOLOR) return COLOR_DEPTH.TRUECOLOR;
  if (n >= COLOR_DEPTH.ANSI256) return COLOR_DEPTH.ANSI256;
  return COLOR_DEPTH.ANSI16;
}

/**
 * Motion is a TTY property, deliberately independent of colour depth: a monochrome TTY can
 * still animate, and a `FORCE_COLOR` pipe must not. `CI` suppresses it because CI logs are
 * files that happen to scroll.
 */
function resolveMotion(stream, env) {
  if ("AIOS_UI_MOTION" in env) return envFlag(env.AIOS_UI_MOTION);
  if (!stream || stream.isTTY !== true) return false;
  if (String(env.TERM ?? "").toLowerCase() === "dumb") return false;
  if (envFlag(env.CI)) return false;
  return true;
}

function resolveTier(env, colorDepth, motion) {
  const override = String(env.AIOS_UI_TIER ?? "").toLowerCase();
  if (TIERS.includes(override)) return override;
  if (motion) return "rich";
  if (colorDepth > COLOR_DEPTH.NONE) return "basic";
  return "plain";
}

function resolveGlyphs(env) {
  const override = String(env.AIOS_UI_GLYPHS ?? "").toLowerCase();
  if (GLYPH_SETS.includes(override)) return override;
  return "unicode";
}

function resolveWidth(stream, env) {
  const override = Number.parseInt(String(env.AIOS_UI_WIDTH ?? ""), 10);
  if (Number.isFinite(override) && override > 0) return override;
  const columns = Number(stream?.columns);
  if (Number.isFinite(columns) && columns > 0) return columns;
  return DEFAULT_WIDTH;
}

function resolveBackground(env) {
  const override = String(env.AIOS_UI_BG ?? "").toLowerCase();
  if (override === "dark" || override === "light") return override;
  // No OSC 11 query (rule 3). Dark is the safer default: the palette's dim and blue are
  // less legible on dark than its bright tones are on light, so guessing dark degrades
  // more gracefully than guessing light.
  return "dark";
}

/**
 * Memoised contexts, keyed by stream identity then by capability and env snapshots. A
 * WeakMap so a short-lived fake stream in a test does not pin a context forever.
 */
const CACHE = new WeakMap();
/** Contexts for calls that passed no stream at all (`stream: undefined`). */
const NO_STREAM_CACHE = new Map();

function envSnapshot(env) {
  // JSON, not a delimiter join: env values are arbitrary strings and any separator
  // byte we picked could appear inside one, silently aliasing two different environments.
  return JSON.stringify(ENV_KEYS.map((k) => (k in env ? String(env[k]) : null)));
}

function streamSnapshot(stream) {
  const columns = Number(stream?.columns);
  return JSON.stringify([stream?.isTTY === true, Number.isFinite(columns) ? columns : null]);
}

/**
 * Resolve the capabilities of one stream under one environment.
 *
 * @param {object}  [options]
 * @param {"human"|"json"|"porcelain"} [options.mode="human"]
 *   Supplied by the command from its own flag parsing — NEVER sniffed from `process.argv`.
 *   Anything but `"human"` forces a null-decoration context.
 * @param {NodeJS.WriteStream} [options.stream]  The stream this output will be written to.
 * @param {object}  [options.env=process.env]    Environment to resolve against.
 * @param {number}  [options.colorDepth]         Explicit override; outranks every env rule.
 * @returns {Readonly<{mode: string, stream: object|undefined, colorDepth: number,
 *   motion: boolean, tier: string, glyphs: string, width: number, background: string}>}
 *   A frozen value object. Cheap and memoised — call it per write rather than caching it
 *   yourself, so changed stream capabilities or environment are picked up.
 */
export function resolveOutputContext({
  mode = "human",
  stream,
  env = process.env,
  colorDepth,
} = {}) {
  if (!MODES.includes(mode)) {
    throw new TypeError(`resolveOutputContext: unknown mode ${JSON.stringify(mode)}`);
  }

  // Only the cacheable shape (no explicit depth override) goes through the memo; an
  // explicit depth is a one-off by definition and must not pollute the shared entry.
  const cacheable = colorDepth === undefined || colorDepth === null;
  const key = `${mode}|${streamSnapshot(stream)}|${envSnapshot(env)}`;

  if (cacheable) {
    const bucket = stream ? CACHE.get(stream) : NO_STREAM_CACHE;
    const hit = bucket?.get(key);
    if (hit) return hit;
  }

  const ctx = buildContext({ mode, stream, env, colorDepth });

  if (cacheable) {
    let bucket = stream ? CACHE.get(stream) : NO_STREAM_CACHE;
    if (!bucket) {
      bucket = new Map();
      CACHE.set(stream, bucket);
    }
    bucket.set(key, ctx);
  }

  return ctx;
}

function buildContext({ mode, stream, env, colorDepth }) {
  if (mode !== "human") {
    // Null decoration by construction (rule 4). The width and background are still
    // resolved because a machine context may still need to size a stderr diagnostic.
    return Object.freeze({
      mode,
      stream,
      colorDepth: COLOR_DEPTH.NONE,
      motion: false,
      tier: "plain",
      glyphs: "ascii",
      width: resolveWidth(stream, env),
      background: resolveBackground(env),
    });
  }

  const depth = resolveColorDepth(stream, env, colorDepth);
  const motion = resolveMotion(stream, env);
  return Object.freeze({
    mode,
    stream,
    colorDepth: depth,
    motion,
    tier: resolveTier(env, depth, motion),
    glyphs: resolveGlyphs(env),
    width: resolveWidth(stream, env),
    background: resolveBackground(env),
  });
}

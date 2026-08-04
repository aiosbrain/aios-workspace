/**
 * dispatch.mjs — argv → descriptor → root resolution → handler (AIO-512 Phase 1).
 *
 * This is the whole `aios` control flow, and it is deliberately boring: every behavior here
 * is a 1:1 port of the if/else-if chain that used to sit at the bottom of scripts/aios.mjs.
 * The four behaviors that are easy to break and are parity-tested in test/cli-registry.test.mjs:
 *
 *   1. help  — no command, `-h`, `--help`, `help` → print help, exit 0 (works with no repo).
 *   2. unknown command → print help, exit 1.
 *   3. `--repo` is consumed here for every command EXCEPT the descriptors that own the flag
 *      themselves (pr / consolidate-findings / timeline).
 *   4. resolution mode decides repo + cfg, and nothing else may:
 *        pre-config   → no repo, no cfg, no secret patterns (mcp: env-first, workspace-free)
 *        update-root  → findUpdateRoot + isUpdateRoot validation (also for an explicit --repo)
 *        offline      → findRepoRootOffline; aios.yaml optional (loadOfflineConfig fallback)
 *        workspace    → findRepoRoot; aios.yaml REQUIRED (die otherwise)
 *
 * This module imports nothing from scripts/aios.mjs — the resolvers and the inline handlers are
 * injected — so it stays a leaf and adding it costs no cold-start time.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { consumeDevtoolsDirArg } from "../devtools-dispatch.mjs";
import { findAgentWorkspace } from "./agent-workspace.mjs";
import { findCommand, nearestCommand, renderUsage } from "./registry.mjs";

const HELP_TOKENS = new Set(["-h", "--help", "help"]);

/**
 * @param {object} o
 * @param {string[]} o.argv        process.argv.slice(2)
 * @param {object} o.local         inline handlers + helpers still living in scripts/aios.mjs
 * @param {object} o.resolvers     { findRepoRoot, findRepoRootOffline, findUpdateRoot,
 *                                   isUpdateRoot, loadConfig, loadOfflineConfig,
 *                                   loadSecretPatterns, die }
 */
export async function dispatch({ argv, local, resolvers }) {
  const cmd = argv[0];
  const rest = argv.slice(1);
  const { die } = resolvers;

  if (!cmd || HELP_TOKENS.has(cmd)) {
    console.log(renderUsage());
    process.exit(0);
  }

  const desc = findCommand(cmd);
  if (!desc) {
    // The help still goes to stdout (it is the useful payload), but the DIAGNOSTIC goes to stderr
    // and names what was actually wrong. Before, `aios bogus 2>err.log` captured nothing and the
    // user got 176 lines of help with no line saying which word was unknown (audit S6-4).
    const near = nearestCommand(cmd);
    console.log(renderUsage());
    console.error(
      `error: unknown command: ${cmd}` + (near ? ` — did you mean \`aios ${near}\`?` : "")
    );
    process.exit(1);
  }

  // The devtools checkout selector chooses which implementation the lazy loader imports; it is
  // not an argument to that implementation. The loader reads the original process argv, while
  // this removes the selector pair from the command-facing `rest` array.
  if (desc.usesDevtoolsDir) consumeDevtoolsDirArg(rest);

  // `pr` and `consolidate-findings` own their own `--repo` flag — a GitHub owner/repo slug,
  // NOT the workspace path. `timeline` owns it too — repeatable TARGET repo paths (its
  // workspace root comes from the cwd walk-up or its own `--workspace`). Don't consume it
  // here, or the command never sees the target-repo override.
  let repoArg = null;
  if (!desc.ownsRepoFlag) {
    const i = rest.indexOf("--repo");
    if (i !== -1) {
      repoArg = rest[i + 1];
      // A valueless trailing `--repo` used to be dropped silently, so resolution fell back to
      // the cwd walk-up and the command ran against whatever workspace happened to be above
      // it. For `push` that means syncing the wrong repo — fail loudly instead.
      if (repoArg === undefined) die(`\`aios ${cmd} --repo\` needs a path — got no value`);
      rest.splice(i, 2);
    }
  }

  // `pre-config` owns the process before any repo resolution and never sees secret patterns.
  // It is also outside the catch below, exactly as the old `mcp` early-exit block was.
  if (desc.resolution === "pre-config") {
    const mod = await desc.loader();
    const ctx = { repo: null, cfg: null, patterns: null, rest, local };
    return finish(desc, await desc.adapt(ctx, mod));
  }

  const { repo, cfg } = resolveRoot(desc, repoArg, rest, resolvers);
  const patterns = resolvers.loadSecretPatterns();

  try {
    const mod = desc.loader ? await desc.loader() : null;
    return finish(desc, await desc.adapt({ repo, cfg, patterns, rest, local }, mod));
  } catch (e) {
    die(e.message);
  }
}

function resolveRoot(desc, repoArg, rest, r) {
  let repo, cfg;
  // This is deliberately opt-in per command.  A configured agent workspace is
  // appropriate for account-scoped integration operations, but must not turn a
  // bare `aios push` in an arbitrary repository into a sync of somebody else's
  // workspace.
  const localWorkspace = repoArg ? null : r.findRepoRoot(process.cwd());
  const agentWorkspace = () =>
    !repoArg && desc.agentWorkspaceFallback ? findAgentWorkspace(r.die) : null;
  if (desc.resolution === "update-root") {
    // update resolves a workspace OR the toolkit checkout — never a bare README dir (see
    // findUpdateRoot). An explicit --repo is validated the SAME way, so it can't be pointed at
    // an arbitrary directory to re-vendor governance into. May run inside the toolkit (no
    // aios.yaml), so config loads offline.
    repo = repoArg ? path.resolve(repoArg) : r.findUpdateRoot(process.cwd());
    if (!repo || !r.isUpdateRoot(repo))
      r.die(
        "`aios update` must run in a workspace (aios.yaml) or the toolkit checkout — pass --repo <path>"
      );
    cfg = hasConfig(repo) ? r.loadConfig(repo) : r.loadOfflineConfig(repo);
  } else if (desc.resolution === "offline") {
    // Offline commands don't require aios.yaml (analyze reads local ~/.<tool> logs; time reads
    // ~/.claude session logs; --push uses env/.env or aios.yaml brain config).
    repo = repoArg
      ? path.resolve(repoArg)
      : localWorkspace || agentWorkspace() || r.findRepoRootOffline(process.cwd());
    if (!repo && desc.cwdFallback?.(rest)) repo = process.cwd();
    if (!repo) r.die("could not locate repo root — pass --repo <path>");
    cfg = hasConfig(repo) ? r.loadConfig(repo) : r.loadOfflineConfig(repo);
  } else {
    repo = repoArg ? path.resolve(repoArg) : localWorkspace || agentWorkspace();
    if (!repo) r.die("no aios.yaml found walking up from cwd — pass --repo <path>");
    cfg = r.loadConfig(repo);
  }
  return { repo, cfg };
}

const hasConfig = (repo) => existsSync(path.join(repo, "aios.yaml"));

/**
 * Normalize the handler's return value into this command's declared exit semantics.
 *
 * `exit-status` assigns ONLY for a truthy status. The old `update` branch was
 * `if (result.exitStatus) process.exitCode = result.exitStatus` — it never wrote 0 — so a
 * soft-failure `process.exitCode` set deeper in the command (or in a module it lazily pulled
 * in) survived. An unconditional `?? 0` would silently overwrite that signal and exit green
 * on a failure. Exported for the unit test; dispatch is the only production caller.
 */
export function finish(desc, value) {
  if (desc.exit === "exit-code") process.exit(value ?? 0);
  if (desc.exit === "exit-status" && value) process.exitCode = value;
  return value;
}

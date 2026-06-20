// test/ux/allowlist.mjs — the PURE, zero-dependency Bash allowlist for the agentic UX driver.
//
// Extracted from driver.mjs so it can be unit-tested without importing the Agent SDK. These
// functions decide whether a Bash `command` is allowed for the driver: allowed IFF it parses
// as exactly `agent-browser <subcommand> [args…]` with no shell features and no leading
// env-assignment. Deny (not allow) on any doubt.

// Characters that imply shell interpretation. If ANY appear in the command, deny outright —
// we never try to "understand" a chained/redirected/substituted command.
export const SHELL_METACHARS = /[;|&$`><(){}\n\r]/;

/**
 * Tokenize a SIMPLE command line into argv WITHOUT invoking a shell. Supports plain
 * whitespace-separated tokens and double/single quoted tokens (so a URL with a query
 * string can be one arg). Returns { ok, argv } or { ok:false, reason }.
 *
 * Importantly: this is intentionally strict. We reject anything that even smells like
 * shell syntax via SHELL_METACHARS first; here we only have to split safe tokens.
 */
export function tokenizeSimpleCommand(command) {
  if (typeof command !== "string") return { ok: false, reason: "command is not a string" };
  const cmd = command.trim();
  if (!cmd) return { ok: false, reason: "empty command" };
  if (SHELL_METACHARS.test(cmd)) return { ok: false, reason: "contains a shell metacharacter" };

  const argv = [];
  let i = 0;
  while (i < cmd.length) {
    while (i < cmd.length && /\s/.test(cmd[i])) i++;
    if (i >= cmd.length) break;
    let token = "";
    if (cmd[i] === '"' || cmd[i] === "'") {
      const quote = cmd[i++];
      while (i < cmd.length && cmd[i] !== quote) token += cmd[i++];
      if (i >= cmd.length) return { ok: false, reason: "unterminated quote" };
      i++; // skip closing quote
    } else {
      while (i < cmd.length && !/\s/.test(cmd[i])) {
        // A quote in the MIDDLE of a bare token implies shell-style concatenation — reject.
        if (cmd[i] === '"' || cmd[i] === "'") return { ok: false, reason: "embedded quote" };
        token += cmd[i++];
      }
    }
    argv.push(token);
  }
  return { ok: true, argv };
}

/**
 * Decide whether a Bash `command` is allowed for the driver. Allowed IFF it parses as
 * exactly `agent-browser <subcommand> [args…]` with no shell features and no leading
 * env-assignment. Returns { allow:boolean, reason }.
 */
export function isAgentBrowserCommand(command) {
  const tok = tokenizeSimpleCommand(command);
  if (!tok.ok) return { allow: false, reason: tok.reason };
  const argv = tok.argv;
  if (!argv.length) return { allow: false, reason: "no argv" };
  // Leading env-assignment (e.g. `FOO=bar agent-browser …`) — the first token must be the
  // binary itself, never `NAME=value`.
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0]))
    return { allow: false, reason: "leading env-assignment" };
  if (argv[0] !== "agent-browser")
    return { allow: false, reason: `non-allowed binary '${argv[0]}'` };
  // Skip leading GLOBAL flags (e.g. `--session <name>`, `--json`) to find the subcommand.
  // A flag is `--name` / `-x`; `--session` and `--profile` take a following value.
  const VALUE_FLAGS = new Set(["--session", "--profile", "--cwd", "--timeout"]);
  let i = 1;
  while (i < argv.length && argv[i].startsWith("-")) {
    if (!/^--?[a-z][a-z0-9-]*$/.test(argv[i]))
      return { allow: false, reason: `bad flag '${argv[i]}'` };
    if (VALUE_FLAGS.has(argv[i])) i++; // consume its value
    i++;
  }
  if (i >= argv.length) return { allow: false, reason: "missing subcommand" };
  // Subcommand must be a plain word (defense in depth; metachars already rejected).
  if (!/^[a-z][a-z-]*$/.test(argv[i]))
    return { allow: false, reason: `bad subcommand '${argv[i]}'` };
  return { allow: true, reason: "ok" };
}

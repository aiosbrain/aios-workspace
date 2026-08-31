/**
 * Argument parsing for `aios slack …` (AIO-1068). Ports the slack.py argparse surface:
 * value flags, boolean flags, one optional positional, `--json` accepted anywhere, and
 * mutually-exclusive requirement groups (--target|--member, --message|--message-stdin).
 */
import { AiosError } from "../../cli.mjs";

const usageError = (message) =>
  new AiosError("AIOS_E_USAGE", message, "Run `aios slack help` for the verb reference.");

// A misplaced argv value can be a pasted credential (`aios slack xoxp-… whoami`,
// `aios slack whoami xoxp-…`). Usage errors echo the offending argument so the user can
// find their typo — but never when it is token-shaped, or the echo itself becomes the
// leak in a CI/agent log (AIO-1068 round-4 egress audit).
const SECRET_SHAPED = /^(xox[a-z]-|sk-|ghp_|github_pat_|lin_api_|glpat-|Bearer\s)/i;
export const shownArg = (value) =>
  SECRET_SHAPED.test(String(value ?? "")) ? "(token-shaped value not shown)" : value;

const MESSAGE_FLAGS = {
  target: "value",
  message: "value",
  "message-stdin": "boolean",
  thread: "value",
};

/**
 * The full argv contract for every verb, in ONE table, so `cmdSlack` can parse and
 * validate an invocation COMPLETELY before any credential resolves (round-5 structural
 * fix: help and usage errors are offline by construction, and a flag VALUE that happens
 * to spell "--help" is data, not help).
 */
export const VERB_SPECS = Object.freeze({
  whoami: {},
  resolve: { flags: { member: "value" }, positional: "email", requireOneOf: [["member", "email"]] },
  channels: { flags: { types: "value" } },
  read: {
    flags: { target: "value", limit: "value", thread: "value" },
    requireOneOf: [["target"]],
    validate: (args) => {
      const limit = args.limit ? Number(args.limit) : 20;
      if (!Number.isInteger(limit) || limit < 1) {
        throw usageError("--limit must be a positive integer.");
      }
    },
  },
  send: { flags: MESSAGE_FLAGS, requireOneOf: [["target"], ["message", "message-stdin"]] },
  dm: {
    flags: { ...MESSAGE_FLAGS, member: "value" },
    requireOneOf: [
      ["target", "member"],
      ["message", "message-stdin"],
    ],
  },
  react: {
    flags: { target: "value", ts: "value", emoji: "value" },
    requireOneOf: [["target"], ["ts"], ["emoji"]],
  },
  file: {
    flags: {
      target: "value",
      member: "value",
      path: "value",
      message: "value",
      "allow-outside-workspace": "boolean",
    },
    requireOneOf: [["target", "member"], ["path"]],
  },
  "file-delete": {
    positional: "file",
    validate: (args) => {
      if (!args.file) throw usageError("file-delete requires a Slack file id (F…).");
    },
  },
  connect: { flags: { stdin: "boolean" }, positional: "token" },
  status: {},
  disconnect: {},
});

/**
 * @param {string[]} argv       argv after the verb
 * @param {object}   spec       { flags: {name: "value"|"boolean"}, positional?: string,
 *                               requireOneOf?: string[][], validate?: (parsed) => void }
 */
export function parseVerbArgs(argv, spec = {}) {
  const flags = { json: "boolean", ...(spec.flags ?? {}) };
  const parsed = { json: false };
  const positionals = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      const kind = flags[name];
      if (!kind) throw usageError(`Unknown option --${name}.`);
      if (kind === "boolean") {
        parsed[camel(name)] = true;
      } else {
        const value = argv[++index];
        if (value === undefined) throw usageError(`--${name} requires a value.`);
        parsed[camel(name)] = value;
      }
    } else {
      positionals.push(arg);
    }
  }
  if (positionals.length > (spec.positional ? 1 : 0)) {
    throw usageError(`Unexpected argument: ${shownArg(positionals[spec.positional ? 1 : 0])}`);
  }
  if (spec.positional && positionals.length) parsed[spec.positional] = positionals[0];
  for (const group of spec.requireOneOf ?? []) {
    const present = group.filter((name) => parsed[camel(name)] !== undefined);
    if (present.length !== 1) {
      throw usageError(
        `Exactly one of ${group.map((name) => `--${name}`).join(" | ")} is required.`
      );
    }
  }
  spec.validate?.(parsed);
  return parsed;
}

const camel = (name) => name.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());

/**
 * Message text: --message verbatim, or the COMPLETE stdin when --message-stdin is set.
 * Stdin is read as raw bytes and decoded once — multiline content and shell-hostile
 * characters arrive exactly as piped (the byte-fidelity contract from slack.py).
 */
export async function readMessage(parsed, stdin = process.stdin) {
  if (!parsed.messageStdin) return parsed.message;
  const chunks = [];
  for await (const chunk of stdin) chunks.push(chunk);
  const message = Buffer.concat(chunks).toString("utf8");
  if (!message) throw usageError("--message-stdin received empty input.");
  return message;
}

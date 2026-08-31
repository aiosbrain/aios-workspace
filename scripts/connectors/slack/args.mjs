/**
 * Argument parsing for `aios slack …` (AIO-1068). Ports the slack.py argparse surface:
 * value flags, boolean flags, one optional positional, `--json` accepted anywhere, and
 * mutually-exclusive requirement groups (--target|--member, --message|--message-stdin).
 */
import { AiosError } from "../../cli.mjs";

const usageError = (message) =>
  new AiosError("AIOS_E_USAGE", message, "Run `aios slack help` for the verb reference.");

/**
 * @param {string[]} argv       argv after the verb
 * @param {object}   spec       { flags: {name: "value"|"boolean"}, positional?: string,
 *                               requireOneOf?: string[][] }
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
    throw usageError(`Unexpected argument: ${positionals[spec.positional ? 1 : 0]}`);
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

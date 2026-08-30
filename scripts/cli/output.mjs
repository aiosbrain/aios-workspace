import { normalizeError } from "./errors.mjs";

const writeLine = (stream, value) => stream.write(`${value}\n`);

/** Stable output boundary for v2 commands. */
export function createOutput({
  json = false,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  let stdoutValues = 0;
  return Object.freeze({
    diagnostic(message) {
      writeLine(stderr, String(message));
    },
    success(value, human = String(value ?? "")) {
      if (json) {
        if (stdoutValues++) throw new Error("JSON stdout already contains a value");
        writeLine(stdout, JSON.stringify(value));
      } else if (human !== "") {
        writeLine(stdout, human);
      }
      return 0;
    },
    failure(error) {
      const normalized = normalizeError(error);
      if (json) {
        if (stdoutValues++) throw new Error("JSON stdout already contains a value");
        writeLine(stdout, JSON.stringify(normalized));
      } else {
        writeLine(stderr, `error [${normalized.code}]: ${normalized.message}`);
        writeLine(stderr, `remediation: ${normalized.remediation}`);
      }
      return normalized.exitCode;
    },
  });
}

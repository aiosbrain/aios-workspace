export const CORE_ERROR_CODES = Object.freeze([
  "AIOS_E_USAGE",
  "AIOS_E_CONFIG_MISSING",
  "AIOS_E_CONFIG_INVALID",
  "AIOS_E_CREDENTIAL_MISSING",
  "AIOS_E_CREDENTIAL_INCOMPLETE",
  "AIOS_E_DESTINATION_UNTRUSTED",
  "AIOS_E_NETWORK",
  "AIOS_E_PROVIDER",
  "AIOS_E_CONFLICT",
  "AIOS_E_MIGRATION",
  "AIOS_E_INTERNAL",
]);

const EXIT_BY_CODE = Object.freeze({
  AIOS_E_USAGE: 2,
  AIOS_E_CONFIG_MISSING: 3,
  AIOS_E_CONFIG_INVALID: 3,
  AIOS_E_CREDENTIAL_MISSING: 3,
  AIOS_E_CREDENTIAL_INCOMPLETE: 3,
  AIOS_E_DESTINATION_UNTRUSTED: 3,
  AIOS_E_NETWORK: 4,
  AIOS_E_PROVIDER: 4,
  AIOS_E_CONFLICT: 5,
  AIOS_E_MIGRATION: 5,
  AIOS_E_INTERNAL: 6,
});

export class AiosError extends Error {
  constructor(code, message, remediation, options = {}) {
    if (!(code in EXIT_BY_CODE)) throw new TypeError(`unknown AIOS error code: ${code}`);
    if (!String(remediation ?? "").trim()) throw new TypeError(`${code} needs remediation`);
    super(String(message), options);
    this.name = "AiosError";
    this.code = code;
    this.remediation = String(remediation);
    this.exitCode = EXIT_BY_CODE[code];
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        remediation: this.remediation,
      },
    };
  }
}

export function normalizeError(error) {
  if (error instanceof AiosError) return error;
  return new AiosError(
    "AIOS_E_INTERNAL",
    "The CLI failed unexpectedly.",
    "Re-run with aios doctor --json and report the diagnostic output.",
    { cause: error }
  );
}

export function exitCodeFor(error) {
  return normalizeError(error).exitCode;
}

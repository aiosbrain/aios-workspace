import { AiosError } from "./errors.mjs";

const present = (candidate) => candidate !== null && candidate !== undefined;

/**
 * Select one complete credential root. A present-but-incomplete root stops resolution; lower roots
 * are never consulted and optional fields are never assembled across sources.
 */
export async function resolveCredentialRoot({
  roots,
  requiredFields,
  resolveReference = async (v) => v,
}) {
  for (const root of roots) {
    const candidate = await root.load();
    if (!present(candidate)) continue;
    const missing = requiredFields.filter(
      (field) => candidate[field] === undefined || candidate[field] === ""
    );
    if (missing.length) {
      throw new AiosError(
        "AIOS_E_CREDENTIAL_INCOMPLETE",
        `Credential source '${root.name}' is incomplete (missing: ${missing.join(", ")}).`,
        `Complete '${root.name}' or remove it so a lower-precedence complete source can be selected.`
      );
    }
    const values = {};
    for (const [field, value] of Object.entries(candidate)) {
      values[field] = await resolveReference(value, { root: root.name, field });
    }
    return {
      values,
      source: Object.freeze({
        name: root.name,
        fields: Object.keys(candidate).sort((a, b) => a.localeCompare(b)),
      }),
    };
  }
  throw new AiosError(
    "AIOS_E_CREDENTIAL_MISSING",
    "No credential source is configured.",
    "Configure one complete credential source and reference it from user or workspace config."
  );
}

export function redactedCredential(result) {
  return { source: result.source, configured: true };
}

import { UpdateError } from "./cli-common.mjs";

const BOOL = new Set([
  "--check",
  "--preview",
  "--no-pull",
  "--stash",
  "--no-install",
  "--force",
  "--with-ci-workflow",
  "--dry-run",
  "--rollback",
  "--self",
  "--vendor-apply-only",
]);
const VALUE = new Set([
  "--from",
  "--repo",
  "--contribute",
  "--result-file",
  "--stamp-source",
  "--expect-src-head",
]);
const CHILD = new Set([
  "--vendor-apply-only",
  "--from",
  "--repo",
  "--force",
  "--with-ci-workflow",
  "--result-file",
  "--stamp-source",
  "--expect-src-head",
]);

/** Parse authority before root/config discovery or any side effect. Also used by library callers. */
export function parseUpdateArgs(args) {
  const flags = new Map();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!BOOL.has(flag) && !VALUE.has(flag))
      throw new UpdateError(`aios update: unknown flag ${flag}`);
    if (flags.has(flag)) throw new UpdateError(`aios update: duplicate flag ${flag}`);
    let value = true;
    if (VALUE.has(flag)) {
      value = args[++i];
      if (!value || value.startsWith("--"))
        throw new UpdateError(`aios update: ${flag} needs a value`);
    }
    flags.set(flag, value);
  }
  if (flags.has("--vendor-apply-only")) {
    for (const flag of flags.keys())
      if (!CHILD.has(flag)) {
        throw new UpdateError(
          `aios update --vendor-apply-only accepts only --from/--repo/--force/--result-file/--stamp-source/--expect-src-head — got ${flag}.`
        );
      }
    return { mode: "internal", resultFile: flags.get("--result-file") };
  }
  for (const flag of ["--result-file", "--stamp-source"])
    if (flags.has(flag)) {
      throw new UpdateError(`aios update: ${flag} belongs only to the internal vendor hand-off`);
    }
  for (const mode of ["self", "rollback"])
    if (flags.has(`--${mode}`)) {
      const allowed = mode === "rollback" ? ["--rollback", "--repo"] : ["--self"];
      if ([...flags.keys()].some((flag) => !allowed.includes(flag))) {
        throw new UpdateError(
          `aios update --${mode} cannot be combined with other flags${mode === "rollback" ? " except --repo" : ""}.`
        );
      }
      return { mode };
    }
  const check = flags.has("--check");
  const preview = flags.has("--preview") || flags.has("--dry-run");
  if (check && preview) throw new UpdateError("aios update: select only one read-only mode");
  if (flags.has("--contribute")) {
    if (check || flags.has("--preview"))
      throw new UpdateError(
        "aios update --contribute cannot be combined with --check/--preview; use --dry-run"
      );
    return { mode: "contribute" };
  }
  return { mode: check ? "check" : preview ? "preview" : "apply" };
}

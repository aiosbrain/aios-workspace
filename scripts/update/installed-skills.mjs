import path from "node:path";
import { existsSync } from "node:fs";
import { managedPathsForConfig } from "../toolkit-manifest.mjs";

const CONNECTOR_SKILLS = ["linear-direct", "slack-personal"];
const entries = CONNECTOR_SKILLS.map((name) => ({
  dest: `.claude/skills/${name}`,
  src: `scaffold/.claude/descriptors/skills/${name}`,
  kind: "dir",
}));

/** Connected skills are copies of descriptor templates; update only installed copies. */
export function managedPathsForWorkspace(repo, cfg = {}) {
  return [
    ...managedPathsForConfig(cfg).map((entry) =>
      entry.dest === ".claude/skills"
        ? { ...entry, exclude: [...(entry.exclude ?? []), ...CONNECTOR_SKILLS] }
        : entry
    ),
    ...entries.filter((entry) => repo && existsSync(path.join(repo, entry.dest, "SKILL.md"))),
  ];
}

/** A skill connected after the stamp was written shares its descriptor's pinned base. */
export function withInstalledSkillBases(resolver) {
  return {
    ...resolver,
    base(src, dest) {
      const base = resolver.base(src, dest);
      const entry = entries.find(
        (e) => dest?.startsWith(`${e.dest}/`) && src.startsWith(`${e.src}/`)
      );
      return base ?? (entry ? resolver.base(src, src.slice("scaffold/".length)) : undefined);
    },
    baseFiles(entry) {
      const files = resolver.baseFiles(entry);
      if (!entries.some((e) => e.src === entry.src && e.dest === entry.dest)) return files;
      return [
        ...new Set([
          ...files,
          ...resolver.baseFiles({ ...entry, dest: entry.src.slice("scaffold/".length) }),
        ]),
      ];
    },
  };
}

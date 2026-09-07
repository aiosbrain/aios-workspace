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
    baseMappings(entry) {
      const files = resolver.baseMappings(entry);
      if (!entries.some((e) => e.src === entry.src && e.dest === entry.dest)) return files;
      const descriptorDest = entry.src.slice("scaffold/".length);
      const aliases = resolver
        .baseMappings({ ...entry, dest: descriptorDest })
        .map(({ srcRel, destRel }) => ({
          srcRel,
          destRel: entry.dest + destRel.slice(descriptorDest.length),
        }));
      return [
        ...new Map(
          [...files, ...aliases].map((f) => [JSON.stringify([f.srcRel, f.destRel]), f])
        ).values(),
      ];
    },
  };
}

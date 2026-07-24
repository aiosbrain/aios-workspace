import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export function enableTranscriptSync(repo) {
  const file = path.join(repo, "aios.yaml");
  const yaml = readFileSync(file, "utf8");
  if (/^\s*-\s+1-inbox\/transcripts\s*$/m.test(yaml)) return false;
  const marker = /^sync_exclude:/m;
  if (!marker.test(yaml)) throw new Error("aios.yaml has no sync_exclude section");
  writeFileSync(file, yaml.replace(marker, "  - 1-inbox/transcripts\nsync_exclude:"));
  return true;
}

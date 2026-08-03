import { readFileSync } from "node:fs";
import path from "node:path";

function readIf(filePath, readFile) {
  try {
    return { text: readFile(filePath, "utf8"), error: null };
  } catch (error) {
    if (error?.code === "ENOENT") return { text: null, error: null };
    return { text: null, error };
  }
}

function stripInertMarkdown(text) {
  let fence = null;
  let comment = false;
  const visibleLines = [];

  for (const rawLine of text.split("\n")) {
    if (fence) {
      const closing = rawLine.match(/^( {0,3})(`{3,}|~{3,})[ \t]*$/);
      if (closing && closing[2][0] === fence.character && closing[2].length >= fence.length) {
        fence = null;
      }
      continue;
    }

    let line = "";
    let cursor = 0;
    while (cursor < rawLine.length) {
      if (comment) {
        const end = rawLine.indexOf("-->", cursor);
        if (end === -1) break;
        comment = false;
        cursor = end + 3;
        continue;
      }
      const start = rawLine.indexOf("<!--", cursor);
      if (start === -1) {
        line += rawLine.slice(cursor);
        break;
      }
      line += rawLine.slice(cursor, start);
      comment = true;
      cursor = start + 4;
    }

    const opening = line.match(/^( {0,3})(`{3,}|~{3,})(.*)$/);
    if (!opening || (opening[2][0] === "`" && opening[3].includes("`"))) {
      visibleLines.push(line);
      continue;
    }
    fence = { character: opening[2][0], length: opening[2].length };
  }

  return visibleLines.join("\n");
}

function sectionBody(text, heading) {
  const matches = [...text.matchAll(new RegExp(`^${heading}$`, "gm"))];
  if (matches.length !== 1) return null;
  const rest = text.slice(matches[0].index + matches[0][0].length);
  const nextHeading = rest.search(/^##\s/m);
  return nextHeading === -1 ? rest : rest.slice(0, nextHeading);
}

export function checkVersionLabels(repoPath, readFile = readFileSync) {
  const brainApi = readIf(path.join(repoPath, "docs", "brain-api.md"), readFile);
  if (brainApi.error) return { ok: false, value: null, detail: "couldn't read docs/brain-api.md" };
  if (brainApi.text === null) {
    const packageJson = readIf(path.join(repoPath, "package.json"), readFile);
    if (packageJson.error) return { ok: false, value: null, detail: "couldn't read package.json" };
    const toolkitMarkers = ["scripts/aios.mjs", "scripts/context-health.mjs"].map((relative) =>
      readIf(path.join(repoPath, relative), readFile)
    );
    if (toolkitMarkers.some((marker) => marker.error))
      return { ok: false, value: null, detail: "couldn't inspect toolkit markers" };
    let isToolkit = false;
    try {
      isToolkit =
        JSON.parse(packageJson.text || "{}").name === "@aiosbrain/aios" ||
        toolkitMarkers.some((marker) => marker.text !== null);
    } catch {
      return { ok: false, value: null, detail: "couldn't parse package.json" };
    }
    return isToolkit
      ? { ok: false, value: null, detail: "toolkit is missing docs/brain-api.md" }
      : { ok: true, value: null, detail: "no docs/brain-api.md (non-toolkit repo)" };
  }
  const claude = readIf(path.join(repoPath, "CLAUDE.md"), readFile);
  const constitution = readIf(path.join(repoPath, "docs", "ENGINEERING-CONSTITUTION.md"), readFile);
  if (claude.error || constitution.error)
    return { ok: false, value: null, detail: "couldn't read agent version-label context" };
  const brainApiText = brainApi.text.replace(/\r\n?/g, "\n");
  const claudeText = stripInertMarkdown((claude.text || "").replace(/\r\n?/g, "\n"));
  const constitutionText = stripInertMarkdown((constitution.text || "").replace(/\r\n?/g, "\n"));

  const header = brainApiText.match(
    /^# AIOS Team Brain — API Contract\n\n\*\*Version: ([0-9]+\.[0-9]+)\*\* is the shipped member-facing Brain API \(`\/api\/v1`\)\. \*\*Document revision: ([0-9]+\.[0-9]+)\*\*\nalso carries the separately negotiated internal Executor gateway contract \*\*([0-9]+\.[0-9]+)\*\*;/
  );
  const docRevs = [...brainApiText.matchAll(/\*\*Document revision:\s*([0-9]+\.[0-9]+)\*\*/g)].map(
    (match) => match[1]
  );
  const versions = [...brainApiText.matchAll(/\*\*Version:\s*([0-9]+\.[0-9]+)\*\*/g)].map(
    (match) => match[1]
  );
  const gateways = [
    ...brainApiText.matchAll(/internal Executor gateway contract \*\*([0-9]+\.[0-9]+)\*\*/g),
  ].map((match) => match[1]);
  if (!header || docRevs.length !== 1 || versions.length !== 1 || gateways.length !== 1)
    return {
      ok: false,
      value: null,
      detail: "docs/brain-api.md header is missing a governed version label",
    };
  const [, version, docRev, gateway] = header;

  const claudeSection = sectionBody(
    claudeText,
    "## 4\\. The pinned sync contract — do not drift ⚠️"
  );
  const constitutionSection = sectionBody(constitutionText, "## Quick reference");
  const claudePins = [
    ...(claudeSection || "").matchAll(
      /^\*\*`docs\/brain-api\.md` is the single pinned contract \(document revision \*\*([0-9]+\.[0-9]+)\*\*, member-facing API \*\*([0-9]+\.[0-9]+)\*\*, internal gateway \*\*([0-9]+\.[0-9]+)\*\*, major `\/api\/v1`\)\*\* between this toolkit and\nthe Team Brain\. Both sides build against it\. \*\*Any change to the sync protocol is a versioned change\nin that file first\*\*/gm
    ),
  ].map((match) => ({ document: match[1], member: match[2], gateway: match[3] }));
  const constitutionLabels = [
    ...(constitutionSection || "").matchAll(
      /^\| Sync protocol \| \[`docs\/brain-api\.md`\]\(\.\/brain-api\.md\) \(v([0-9]+\.[0-9]+)\) \|$/gm
    ),
  ].map((match) => match[1]);
  const constitutionLabel = constitutionLabels.length === 1 ? constitutionLabels[0] : null;
  const claudePin = claudePins.length === 1 ? claudePins[0] : null;
  const found =
    claudePin?.document === docRev &&
    claudePin.member === version &&
    claudePin.gateway === gateway &&
    constitutionLabel === docRev;
  return {
    ok: found,
    value: found ? docRev : `expected ${docRev}, not referenced`,
    detail: found
      ? `agent context references brain-api ${docRev}`
      : `CLAUDE.md or docs/ENGINEERING-CONSTITUTION.md doesn't match brain-api's current label (${docRev})`,
  };
}

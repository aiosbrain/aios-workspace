"""Skill catalog, transcript-read, and routing evidence helpers for evolve."""

from __future__ import annotations

import json
import re
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable


SKILL_PATH_RE = re.compile(
    r"(?P<path>(?:~|/|\.\.?/)[^\s\"'`;,|(){}\[\]]+?/SKILL\.md)"
)
USAGE_CUE_RE = re.compile(
    r"\b(?:i(?:'m| am)? using|using|loaded|loading|activate[sd]?|skill(?:s)? active)\b",
    re.IGNORECASE,
)
ROUTING_FILES = ("RESOLVER.md", "CLAUDE.md", "AGENTS.md", "skills/INDEX.md")


def parse_frontmatter(path: Path) -> dict[str, str]:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return {}
    match = re.match(r"\A---\s*\n(.*?)\n---", text, re.DOTALL)
    if not match:
        return {}
    fields: dict[str, str] = {}
    lines = match.group(1).splitlines()
    index = 0
    while index < len(lines):
        line = lines[index]
        if ":" not in line or line[:1].isspace():
            index += 1
            continue
        key, value = line.split(":", 1)
        value = value.strip()
        if value in {"|", ">", "|-", ">-"}:
            parts: list[str] = []
            index += 1
            while index < len(lines) and (not lines[index].strip() or lines[index][:1].isspace()):
                parts.append(lines[index].strip())
                index += 1
            fields[key.strip()] = " ".join(parts).strip()
            continue
        fields[key.strip()] = value.strip("\"'")
        index += 1
    return fields


def default_skill_roots(project_root: Path) -> list[tuple[str, Path]]:
    return [
        ("project-claude", project_root / ".claude" / "skills"),
        ("project-agents", project_root / ".agents" / "skills"),
        ("global-codex", Path.home() / ".codex" / "skills"),
        ("global-agents", Path.home() / ".agents" / "skills"),
        ("global-claude", Path.home() / ".claude" / "skills"),
        ("plugin-cache", Path.home() / ".codex" / "plugins" / "cache"),
    ]


def skill_files(root: Path) -> Iterable[Path]:
    if not root.is_dir():
        return []
    direct = list(root.glob("*/SKILL.md"))
    system = list(root.glob(".system/*/SKILL.md"))
    plugin = list(root.glob("**/skills/*/SKILL.md")) if root.name == "cache" else []
    return sorted({*direct, *system, *plugin})


def inventory_skills(project_root: Path, extra_roots: list[Path]) -> dict[str, Any]:
    sources = default_skill_roots(project_root)
    sources.extend((f"extra-{index + 1}", path) for index, path in enumerate(extra_roots))
    skills: dict[str, dict[str, Any]] = {}
    names_by_source: dict[str, list[str]] = {}
    roots: list[dict[str, Any]] = []
    for label, root in sources:
        names: list[str] = []
        for path in skill_files(root):
            fields = parse_frontmatter(path)
            name = fields.get("name") or path.parent.name
            names.append(name)
            entry = skills.setdefault(
                name,
                {"name": name, "description": fields.get("description", ""), "sources": []},
            )
            if not entry["description"] and fields.get("description"):
                entry["description"] = fields["description"]
            entry["sources"].append({"label": label, "path": str(path)})
        unique_names = sorted(set(names))
        names_by_source[label] = unique_names
        roots.append({"label": label, "path": str(root), "skill_count": len(unique_names)})

    project_claude = set(names_by_source.get("project-claude", []))
    project_agents = set(names_by_source.get("project-agents", []))
    return {
        "distinct_skill_count": len(skills),
        "roots": roots,
        "skills": sorted(skills.values(), key=lambda item: item["name"]),
        "project_catalog_parity": {
            "claude_only": sorted(project_claude - project_agents),
            "agents_only": sorted(project_agents - project_claude),
            "shared": sorted(project_claude & project_agents),
        },
    }


def message_text(payload: dict[str, Any]) -> str:
    content = payload.get("content", [])
    if not isinstance(content, list):
        return ""
    return " ".join(
        str(item.get("text", ""))
        for item in content
        if isinstance(item, dict) and item.get("text")
    )


def tool_input(payload: dict[str, Any]) -> str:
    value = payload.get("input", payload.get("arguments", ""))
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, sort_keys=True)
    except TypeError:
        return str(value)


def extract_workdirs(text: str) -> set[str]:
    return {
        match.group(1)
        for match in re.finditer(r"(?:\\?[\"']?workdir\\?[\"']?)\s*:\s*[\"']([^\"']+)[\"']", text)
    }


def extract_skill_reads(text: str) -> tuple[Counter[str], dict[str, set[str]]]:
    reads: Counter[str] = Counter()
    sources: dict[str, set[str]] = defaultdict(set)
    for match in SKILL_PATH_RE.finditer(text):
        path = match.group("path").rstrip(".:)")
        parts = path.replace("\\", "/").split("/")
        if len(parts) >= 2:
            name = parts[-2]
            if re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", name):
                reads[name] += 1
                sources[name].add(str(Path(path).expanduser()) if path.startswith(("/", "~")) else path)
    if re.search(r"(?<![/a-zA-Z0-9_-])SKILL\.md\b", text):
        for workdir in extract_workdirs(text):
            workdir_path = Path(workdir)
            name = workdir_path.name
            if (
                workdir_path.parent.name in {"skill", "skills"}
                and re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", name)
            ):
                reads[name] += 1
                sources[name].add(str(workdir_path.expanduser() / "SKILL.md"))
    return reads, sources


def extract_declared_skills(text: str, known_names: set[str]) -> set[str]:
    declared: set[str] = set()
    segments = re.split(r"(?:\n+|(?<=[.!?])\s+)", text)
    for segment in segments:
        if not USAGE_CUE_RE.search(segment):
            continue
        if re.search(
            r"\b(?:should|could|consider|recommend|might|would)\b.{0,60}\busing\b",
            segment,
            re.IGNORECASE,
        ):
            continue
        matches: list[tuple[int, int, str]] = []
        for name in known_names:
            tokens = [re.escape(token) for token in re.split(r"[-_\s]+", name.lower())]
            pattern = r"(?<![a-z0-9])" + r"[-_\s]+".join(tokens) + r"(?![a-z0-9])"
            matches.extend((match.start(), match.end(), name) for match in re.finditer(pattern, segment.lower()))
        accepted: list[tuple[int, int, str]] = []
        for candidate in sorted(matches, key=lambda item: (item[1] - item[0]), reverse=True):
            if any(candidate[0] < end and candidate[1] > start for start, end, _ in accepted):
                continue
            accepted.append(candidate)
        declared.update(name for _, _, name in accepted)
    return declared


def likely_routing_read(text: str, routing_file: str) -> bool:
    if routing_file not in text:
        return False
    command_hint = re.compile(r"\b(?:cat|head|less|rg|sed|tail|wc)\b|read[_-]?(?:file|text)", re.I)
    return any(
        routing_file in clause and command_hint.search(clause)
        for clause in re.split(r"(?:&&|\|\||;|\n)", text)
    )


def analyze_transcripts(
    session_ids: set[str],
    metadata: dict[str, dict[str, str]],
    catalog: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:
    known_names = {skill["name"] for skill in catalog["skills"]}
    per_session: dict[str, dict[str, Any]] = {}
    usage_sessions: Counter[str] = Counter()
    read_occurrences: Counter[str] = Counter()
    declared_sessions: Counter[str] = Counter()
    routing_sessions: Counter[str] = Counter()
    routing_likely_reads: Counter[str] = Counter()
    observed_sources: dict[str, set[str]] = defaultdict(set)

    for session_id in session_ids:
        path_text = metadata.get(session_id, {}).get("file", "")
        reads: Counter[str] = Counter()
        declared: set[str] = set()
        routing: set[str] = set()
        routing_reads: set[str] = set()
        session_sources: dict[str, set[str]] = defaultdict(set)
        if path_text:
            try:
                with Path(path_text).open(encoding="utf-8") as handle:
                    for line in handle:
                        try:
                            row = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        if row.get("type") != "response_item":
                            continue
                        payload = row.get("payload", {})
                        payload_type = payload.get("type")
                        if payload_type in {"custom_tool_call", "function_call"}:
                            rendered_input = tool_input(payload)
                            found_reads, found_sources = extract_skill_reads(rendered_input)
                            reads.update(found_reads)
                            for name, paths in found_sources.items():
                                session_sources[name].update(paths)
                            for routing_file in ROUTING_FILES:
                                if routing_file in rendered_input:
                                    routing.add(routing_file)
                                    if likely_routing_read(rendered_input, routing_file):
                                        routing_reads.add(routing_file)
                        elif payload_type == "message" and payload.get("role") == "assistant":
                            declared.update(extract_declared_skills(message_text(payload), known_names))
            except OSError:
                pass

        evidence_names = set(reads) | declared
        for name in evidence_names:
            usage_sessions[name] += 1
        read_occurrences.update(reads)
        for name in declared:
            declared_sessions[name] += 1
        for routing_file in routing:
            routing_sessions[routing_file] += 1
        for routing_file in routing_reads:
            routing_likely_reads[routing_file] += 1
        for name, paths in session_sources.items():
            observed_sources[name].update(paths)
        per_session[session_id] = {
            "skill_instruction_reads": dict(sorted(reads.items())),
            "skill_read_sources": {
                name: sorted(paths) for name, paths in sorted(session_sources.items())
            },
            "declared_skills": sorted(declared),
            "routing_file_mentions": sorted(routing),
            "routing_file_likely_reads": sorted(routing_reads),
        }

    top_skills = [
        {
            "name": name,
            "sessions_with_evidence": count,
            "instruction_read_occurrences": read_occurrences[name],
            "sessions_with_declaration": declared_sessions[name],
            "observed_read_sources": sorted(observed_sources[name]),
        }
        for name, count in usage_sessions.most_common()
    ]
    sessions_with_evidence = sum(
        1
        for evidence in per_session.values()
        if evidence["skill_instruction_reads"] or evidence["declared_skills"]
    )
    return (
        {
            "session_count_analyzed": len(session_ids),
            "sessions_with_skill_evidence": sessions_with_evidence,
            "skill_evidence_coverage": (
                round(sessions_with_evidence / len(session_ids), 4) if session_ids else 0
            ),
            "distinct_skills_with_evidence": len(usage_sessions),
            "top_skills": top_skills,
            "routing_file_mention_sessions": dict(sorted(routing_sessions.items())),
            "routing_file_likely_read_sessions": dict(sorted(routing_likely_reads.items())),
            "used_but_not_cataloged": sorted(set(usage_sessions) - known_names),
            "evidence_caveat": (
                "Instruction reads and declarations are heuristic upper-bound adoption signals; "
                "routing reads are command-pattern heuristics; neither proves workflow completion, "
                "applicability, or compliance."
            ),
        },
        per_session,
    )

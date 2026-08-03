#!/usr/bin/env python3
"""Extract redacted session, skill-use, routing, and catalog evidence for evolve."""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from evolve_evidence import analyze_transcripts, inventory_skills, parse_frontmatter


STOPWORDS = {
    "about", "after", "again", "also", "and", "any", "are", "been", "before",
    "being", "between", "can", "could", "did", "does", "doing", "done", "for",
    "from", "had", "has", "have", "into", "its", "just", "like", "more", "need",
    "not", "only", "other", "our", "over", "please", "should", "that", "the",
    "their", "them", "then", "there", "these", "they", "this", "those", "through",
    "too", "under", "using", "want", "was", "were", "what", "when", "where",
    "which", "while", "with", "would", "you", "your", "youre",
}

CORRECTION_RE = re.compile(
    r"\b(?:actually|do not|don't|instead|no[, ]|not that|skip|stop|wrong|"
    r"it's because|it is because|must not|never)\b",
    re.IGNORECASE,
)

SECRET_PATTERNS = (
    re.compile(r"\b(?:sk|rk)-[A-Za-z0-9_-]{16,}\b"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b"),
    re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{12,}\b"),
    re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{12,}"),
    re.compile(
        r"(?i)[A-Za-z0-9_-]*(?:api[_-]?key|token|password|secret)"
        r"[A-Za-z0-9_-]*\s*[:=]\s*"
        r"['\"]?[A-Za-z0-9._~+/=-]{12,}['\"]?"
    ),
    re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"),
)

def redact(text: str) -> str:
    for pattern in SECRET_PATTERNS:
        text = pattern.sub("[REDACTED]", text)
    return text


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Extract recent Codex prompts, skill usage, routing, and Claude instincts."
    )
    parser.add_argument("--days", type=int, default=21)
    parser.add_argument("--max-sessions", type=int, default=30)
    parser.add_argument("--max-prompts", type=int, default=180)
    parser.add_argument("--history", type=Path, default=Path.home() / ".codex" / "history.jsonl")
    parser.add_argument("--sessions-dir", type=Path, default=Path.home() / ".codex" / "sessions")
    parser.add_argument(
        "--archived-sessions-dir",
        type=Path,
        default=Path.home() / ".codex" / "archived_sessions",
    )
    parser.add_argument("--project-root", type=Path, default=Path.cwd())
    parser.add_argument("--skill-root", type=Path, action="append", default=[])
    parser.add_argument("--all-projects", action="store_true")
    parser.add_argument("--include-instincts", action="store_true")
    parser.add_argument("--include-prompts", action="store_true")
    parser.add_argument("--full-text", action="store_true")
    parser.add_argument("--json", action="store_true", dest="as_json")
    args = parser.parse_args()
    if args.days < 1 or args.max_sessions < 1 or args.max_prompts < 1:
        parser.error("days, max-sessions, and max-prompts must be positive")
    if args.full_text:
        args.include_prompts = True
    return args


def iter_jsonl_files(roots: Iterable[Path]) -> Iterable[Path]:
    seen: set[Path] = set()
    for root in roots:
        if not root.is_dir():
            continue
        for path in root.glob("**/*.jsonl"):
            resolved = path.resolve()
            if resolved not in seen:
                seen.add(resolved)
                yield path


def load_session_metadata(roots: Iterable[Path]) -> dict[str, dict[str, str]]:
    metadata: dict[str, dict[str, str]] = {}
    for path in iter_jsonl_files(roots):
        try:
            with path.open(encoding="utf-8") as handle:
                first = json.loads(handle.readline())
            if first.get("type") != "session_meta":
                continue
            payload = first.get("payload", {})
            session_id = payload.get("session_id") or payload.get("id")
            if session_id:
                metadata[str(session_id)] = {
                    "cwd": str(payload.get("cwd", "")),
                    "file": str(path),
                    "timestamp": str(payload.get("timestamp", "")),
                }
        except (OSError, json.JSONDecodeError, TypeError):
            continue
    return metadata


def path_is_within(candidate: str, root: Path) -> bool:
    if not candidate:
        return False
    try:
        candidate_path = Path(candidate).expanduser().resolve()
        root_path = root.expanduser().resolve()
        return candidate_path == root_path or root_path in candidate_path.parents
    except OSError:
        return False


def load_history(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    try:
        with path.open(encoding="utf-8") as handle:
            for line_number, line in enumerate(handle, 1):
                try:
                    row = json.loads(line)
                    session_id = str(row.get("session_id", "")).strip()
                    text = str(row.get("text", "")).strip()
                    timestamp = int(row.get("ts", 0))
                    if session_id and text and timestamp:
                        rows.append(
                            {
                                "session_id": session_id,
                                "timestamp": timestamp,
                                "text": redact(text),
                            }
                        )
                except (json.JSONDecodeError, TypeError, ValueError):
                    print(
                        f"warning: skipped malformed history line {line_number}",
                        file=sys.stderr,
                    )
    except OSError as exc:
        raise SystemExit(f"cannot read Codex history at {path}: {exc}") from exc
    return rows


def load_instincts() -> list[dict[str, Any]]:
    roots = (
        Path.home() / ".claude" / "homunculus" / "instincts",
        Path.home() / ".claude" / "homunculus" / "projects",
    )
    instincts: list[dict[str, Any]] = []
    for root in roots:
        if not root.is_dir():
            continue
        for path in root.glob("**/*"):
            if not path.is_file() or path.suffix.lower() not in {".md", ".yaml", ".yml"}:
                continue
            fields = parse_frontmatter(path)
            if fields.get("id"):
                instincts.append(
                    {
                        "id": fields["id"],
                        "trigger": redact(fields.get("trigger", "")),
                        "confidence": fields.get("confidence", ""),
                        "domain": fields.get("domain", "general"),
                        "source": str(path),
                    }
                )
    deduped = {item["id"]: item for item in instincts}
    return sorted(deduped.values(), key=lambda item: item["id"])


def select_rows(
    rows: list[dict[str, Any]],
    metadata: dict[str, dict[str, str]],
    args: argparse.Namespace,
) -> tuple[list[dict[str, Any]], bool]:
    project_scoped = not args.all_projects
    if not rows:
        return [], project_scoped
    anchor = max(row["timestamp"] for row in rows)
    cutoff = anchor - args.days * 86400
    recent = [row for row in rows if row["timestamp"] >= cutoff]

    if project_scoped:
        recent = [
            row
            for row in recent
            if path_is_within(metadata.get(row["session_id"], {}).get("cwd", ""), args.project_root)
        ]

    latest_by_session: dict[str, int] = {}
    for row in recent:
        latest_by_session[row["session_id"]] = max(
            latest_by_session.get(row["session_id"], 0), row["timestamp"]
        )
    allowed_sessions = {
        session_id
        for session_id, _ in sorted(
            latest_by_session.items(), key=lambda item: item[1], reverse=True
        )[: args.max_sessions]
    }
    selected = [row for row in recent if row["session_id"] in allowed_sessions]
    selected.sort(key=lambda row: row["timestamp"])
    return selected[-args.max_prompts :], project_scoped


def common_terms(rows: list[dict[str, Any]]) -> tuple[list[tuple[str, int]], list[tuple[str, int]]]:
    words: list[str] = []
    bigrams: list[str] = []
    for row in rows:
        tokens = [
            token
            for token in re.findall(r"[a-z][a-z0-9-]{2,}", row["text"].lower())
            if token not in STOPWORDS and not token.isdigit()
        ]
        words.extend(tokens)
        bigrams.extend(f"{left} {right}" for left, right in zip(tokens, tokens[1:]))
    term_counts = [(term, count) for term, count in Counter(words).most_common(30) if count >= 2]
    bigram_counts = [
        (term, count) for term, count in Counter(bigrams).most_common(20) if count >= 2
    ]
    return term_counts, bigram_counts


def build_report(
    rows: list[dict[str, Any]],
    metadata: dict[str, dict[str, str]],
    instincts: list[dict[str, Any]],
    project_scoped: bool,
    catalog: dict[str, Any],
    args: argparse.Namespace,
) -> dict[str, Any]:
    by_session: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        rendered = dict(row)
        rendered["lexical_correction_candidate"] = bool(CORRECTION_RE.search(row["text"]))
        if args.include_prompts:
            if not args.full_text and len(rendered["text"]) > 1200:
                rendered["text"] = rendered["text"][:1197].rstrip() + "..."
        else:
            rendered.pop("text", None)
            rendered["prompt_text_included"] = False
        by_session[row["session_id"]].append(rendered)

    usage, per_session = analyze_transcripts(set(by_session), metadata, catalog)
    sessions = []
    for session_id, prompts in by_session.items():
        cwd = metadata.get(session_id, {}).get("cwd", "")
        sessions.append(
            {
                "session_id": session_id,
                "cwd": cwd,
                "latest": max(item["timestamp"] for item in prompts),
                "prompts": prompts,
                "usage_evidence": per_session.get(session_id, {}),
            }
        )
    sessions.sort(key=lambda item: item["latest"], reverse=True)
    terms, bigrams = common_terms(rows) if args.include_prompts else ([], [])
    return {
        "window_days": args.days,
        "max_sessions": args.max_sessions,
        "project_scoped": project_scoped,
        "project_root": str(args.project_root.resolve()),
        "session_count": len(sessions),
        "prompt_count": len(rows),
        "common_terms": terms,
        "common_bigrams": bigrams,
        "skill_usage": usage,
        "skill_catalog": catalog,
        "sessions": sessions,
        "legacy_instincts": instincts,
    }


def iso_time(timestamp: int) -> str:
    return datetime.fromtimestamp(timestamp, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def print_markdown(report: dict[str, Any]) -> None:
    scope = "current project tree" if report["project_scoped"] else "all recent projects"
    print("# Evolve evidence")
    print()
    print(
        f"- Window: {report['window_days']} days; scope: {scope}; "
        f"sessions: {report['session_count']}/{report['max_sessions']} cap; "
        f"prompts: {report['prompt_count']}"
    )
    print(f"- Project root: {report['project_root']}")

    usage = report["skill_usage"]
    print("\n## Skill-use and routing evidence\n")
    print(
        f"- Sessions with skill evidence: {usage['sessions_with_skill_evidence']}/"
        f"{usage['session_count_analyzed']} ({usage['skill_evidence_coverage']:.1%})"
    )
    print(f"- Distinct skills with evidence: {usage['distinct_skills_with_evidence']}")
    print(f"- Caveat: {usage['evidence_caveat']}")
    if usage["routing_file_mention_sessions"]:
        rendered = ", ".join(
            f"`{name}` {count}" for name, count in usage["routing_file_mention_sessions"].items()
        )
        print(f"- Routing files mentioned in tool calls: {rendered}")
    if usage["routing_file_likely_read_sessions"]:
        rendered = ", ".join(
            f"`{name}` {count}"
            for name, count in usage["routing_file_likely_read_sessions"].items()
        )
        print(f"- Routing files likely read by a command: {rendered}")
    if usage["used_but_not_cataloged"]:
        print(
            "- Used but not in the current scanned catalog: "
            + ", ".join(f"`{name}`" for name in usage["used_but_not_cataloged"])
        )
    if usage["top_skills"]:
        print("\nTop skill evidence:")
        for item in usage["top_skills"][:20]:
            print(
                f"- `{item['name']}` — sessions {item['sessions_with_evidence']}; "
                f"instruction reads {item['instruction_read_occurrences']}; "
                f"declared sessions {item['sessions_with_declaration']}"
            )

    catalog = report["skill_catalog"]
    parity = catalog["project_catalog_parity"]
    print("\n## Catalog evidence\n")
    print(f"- Distinct installed skills across scanned roots: {catalog['distinct_skill_count']}")
    print("- Catalog caveat: this is the current filesystem snapshot, not historical availability.")
    for root in catalog["roots"]:
        print(f"- `{root['label']}`: {root['skill_count']} at `{root['path']}`")
    if parity["claude_only"]:
        print("- Project `.claude` only: " + ", ".join(f"`{x}`" for x in parity["claude_only"]))
    if parity["agents_only"]:
        print("- Project `.agents` only: " + ", ".join(f"`{x}`" for x in parity["agents_only"]))

    print("\n## Repeated terms (signals, not conclusions)\n")
    print(", ".join(f"`{term}` ({count})" for term, count in report["common_terms"]) or "None")
    print("\nRepeated phrases: " + (
        ", ".join(f"`{term}` ({count})" for term, count in report["common_bigrams"]) or "None"
    ))

    print("\n## Session evidence")
    for session in report["sessions"]:
        print()
        print(f"### {session['session_id'][:12]} — {iso_time(session['latest'])}")
        if session["cwd"]:
            print(f"cwd: `{session['cwd']}`")
        evidence = session.get("usage_evidence", {})
        names = sorted(
            set(evidence.get("skill_instruction_reads", {}))
            | set(evidence.get("declared_skills", []))
        )
        if names:
            print("skill evidence: " + ", ".join(f"`{name}`" for name in names))
        for prompt in session["prompts"]:
            marker = (
                " [lexical correction candidate]"
                if prompt["lexical_correction_candidate"]
                else ""
            )
            if "text" in prompt:
                text = prompt["text"].replace("\n", "\n  ")
                print(f"- {text}{marker}")
            else:
                print(f"- prompt excerpt hidden; rerun with `--include-prompts`{marker}")

    if report["legacy_instincts"]:
        print("\n## Legacy Claude instincts")
        for instinct in report["legacy_instincts"]:
            confidence = f"; confidence {instinct['confidence']}" if instinct["confidence"] else ""
            print(
                f"- `{instinct['id']}` ({instinct['domain']}{confidence}): "
                f"{instinct['trigger']}"
            )


def main() -> int:
    args = parse_args()
    metadata = load_session_metadata((args.sessions_dir, args.archived_sessions_dir))
    rows = load_history(args.history)
    selected, project_scoped = select_rows(rows, metadata, args)
    catalog = inventory_skills(args.project_root, args.skill_root)
    instincts = load_instincts() if args.include_instincts else []
    report = build_report(selected, metadata, instincts, project_scoped, catalog, args)
    if args.as_json:
        json.dump(report, sys.stdout, indent=2)
        print()
    else:
        print_markdown(report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

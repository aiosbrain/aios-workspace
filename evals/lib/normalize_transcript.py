#!/usr/bin/env python3
"""Convert supported runtime JSONL transcripts to normalized eval evidence."""

from __future__ import annotations

import json
import os
import re
import shlex
import sys
from pathlib import Path
from typing import Any


def relative(path: str, workspace: str) -> str:
    try:
        return os.path.relpath(path, workspace) if os.path.isabs(path) else path
    except ValueError:
        return path


def event_base(runtime: str, kind: str, workspace: str, session: str = "") -> dict[str, Any]:
    return {
        "protocol_version": "1.0",
        "event": kind,
        "runtime": {"name": runtime},
        "cwd": workspace,
        "session_id": session,
    }


PYTHON = re.compile(r"^python(?:3(?:\.\d+)*)?$")
ASSIGNMENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")


def command_segments(command: str) -> list[list[str]]:
    """Return simple-command tokens without treating quoted check names as execution."""
    segments: list[list[str]] = []
    for segment in re.split(r"\s*(?:&&|\|\||[;|])\s*", command):
        if not segment.strip():
            continue
        try:
            tokens = shlex.split(segment)
        except ValueError:
            continue
        if tokens:
            segments.append(tokens)
    return segments


def unwrap_command(tokens: list[str]) -> list[str]:
    """Strip environment assignments and common execution wrappers."""
    remaining = list(tokens)
    while remaining and ASSIGNMENT.match(remaining[0]):
        remaining.pop(0)
    while remaining:
        executable = os.path.basename(remaining[0])
        if executable == "env":
            remaining.pop(0)
            while remaining and (remaining[0].startswith("-") or ASSIGNMENT.match(remaining[0])):
                remaining.pop(0)
        elif executable == "command":
            remaining.pop(0)
            while remaining and remaining[0].startswith("-"):
                remaining.pop(0)
        elif executable in {"timeout", "gtimeout"}:
            remaining.pop(0)
            while remaining and remaining[0].startswith("-"):
                remaining.pop(0)
            if remaining:
                remaining.pop(0)
        elif executable in {"uv", "poetry", "pipenv"} and len(remaining) > 1 and remaining[1] == "run":
            remaining = remaining[2:]
        else:
            break
        while remaining and ASSIGNMENT.match(remaining[0]):
            remaining.pop(0)
    return remaining


def check_kind(command: str) -> str | None:
    for tokens in command_segments(command):
        tokens = unwrap_command(tokens)
        if not tokens or not PYTHON.match(os.path.basename(tokens[0])):
            continue
        arguments = tokens[1:]
        if "-c" in arguments:
            continue
        for index, argument in enumerate(arguments):
            if argument == "-m" and index + 1 < len(arguments) and arguments[index + 1] == "unittest":
                return "unittest"
            if not argument.startswith("-") and os.path.basename(argument) == "check.py":
                return "check.py"
    return None


def is_check(command: str) -> bool:
    return check_kind(command) is not None


def fixture_checks(path: str) -> list[dict[str, Any]]:
    checks: list[dict[str, Any]] = []
    try:
        lines = Path(path).read_text(errors="replace").splitlines()
    except OSError:
        return checks
    for line in lines:
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        status = record.get("status")
        if (record.get("record_type") == "check" and
                isinstance(record.get("command"), str) and
                isinstance(status, (int, float)) and not isinstance(status, bool)):
            checks.append(record)
    return checks


def reconcile_checks(events: list[dict[str, Any]], authoritative: list[dict[str, Any]]) -> None:
    """Replace transcript check statuses in place with same-kind fixture exit codes."""
    unused = set(range(len(authoritative)))
    for event in events:
        if event.get("record_type") != "check":
            continue
        kind = check_kind(str(event.get("command") or ""))
        match = next(
            (index for index in sorted(unused)
             if check_kind(str(authoritative[index].get("command") or "")) == kind),
            None,
        )
        if match is not None:
            event["status"] = authoritative[match]["status"]
            unused.remove(match)


def patch_paths(patch: str, workspace: str) -> list[dict[str, str]]:
    changes: list[dict[str, str]] = []
    current = ""
    for line in patch.splitlines():
        for marker, action in (("*** Add File: ", "add"), ("*** Update File: ", "update"), ("*** Delete File: ", "delete")):
            if line.startswith(marker):
                current = line[len(marker):]
                changes.append({"path": relative(current, workspace), "action": action})
                break
        if line.startswith("*** Move to: ") and changes:
            destination = line[len("*** Move to: "):]
            source = current
            current = destination
            changes[-1] = {"path": relative(destination, workspace), "action": "rename", "from": relative(source, workspace)}
    return changes


def codex(record: dict[str, Any], workspace: str) -> list[dict[str, Any]]:
    if record.get("type") != "item.completed":
        return []
    item = record.get("item") or {}
    if item.get("type") == "file_change":
        changes = []
        for change in item.get("changes") or []:
            action = change.get("kind", "unknown")
            if action not in {"add", "update", "delete", "rename"}:
                action = "unknown"
            changes.append({"path": relative(change.get("path", ""), workspace), "action": action})
        if not changes:
            return []
        out = event_base("codex", "pre_edit", workspace)
        out.update({"tool_name": "apply_patch", "tool_id": item.get("id", ""), "paths": changes, "added_content": []})
        return [out]
    if item.get("type") == "command_execution":
        command = item.get("command") or ""
        if not command:
            return []
        out = event_base("codex", "pre_command", workspace)
        out.update({"tool_name": "Bash", "tool_id": item.get("id", ""), "command": command})
        records = [out]
        if is_check(command):
            exit_code = item.get("exit_code", 1)
            if not isinstance(exit_code, (int, float)) or isinstance(exit_code, bool):
                exit_code = 1
            records.append({"record_type": "check", "command": command, "status": exit_code})
        return records
    return []


def claude(record: dict[str, Any], workspace: str, pending: dict[str, str]) -> list[dict[str, Any]]:
    message = record.get("message") or {}
    content = message.get("content") or []
    records: list[dict[str, Any]] = []
    if record.get("type") == "assistant":
        for part in content:
            if part.get("type") != "tool_use":
                continue
            name = part.get("name", "")
            tool_id = part.get("id", "")
            args = part.get("input") or {}
            if name in {"Write", "Edit", "MultiEdit"}:
                path = args.get("file_path") or args.get("path") or ""
                out = event_base("claude", "pre_edit", workspace, record.get("session_id", ""))
                out.update({"tool_name": name, "tool_id": tool_id,
                            "paths": [{"path": relative(path, workspace), "action": "add" if name == "Write" else "update"}],
                            "added_content": [{"path": relative(path, workspace), "content": args.get("content") or args.get("new_string") or ""}]})
                records.append(out)
            elif name == "Bash":
                command = args.get("command") or ""
                pending[tool_id] = command
                out = event_base("claude", "pre_command", workspace, record.get("session_id", ""))
                out.update({"tool_name": name, "tool_id": tool_id, "command": command})
                records.append(out)
    elif record.get("type") == "user":
        for part in content:
            if part.get("type") != "tool_result":
                continue
            tool_id = part.get("tool_use_id", "")
            command = pending.pop(tool_id, "")
            if is_check(command):
                records.append({"record_type": "check", "command": command,
                                "status": 1 if part.get("is_error") else 0})
    return records


def opencode(record: dict[str, Any], workspace: str) -> list[dict[str, Any]]:
    part = record.get("part") or record.get("properties") or {}
    if part.get("type") != "tool":
        return []
    tool = part.get("tool") or part.get("name") or ""
    state = part.get("state") or {}
    args = state.get("input") or part.get("input") or {}
    tool_id = part.get("callID") or part.get("id") or ""
    if tool in {"write", "edit", "apply_patch", "patch"}:
        patch = args.get("patchText") or args.get("patch") or ""
        changes = patch_paths(patch, workspace) if patch else []
        path = args.get("filePath") or args.get("file_path") or args.get("path") or "<patch>"
        if not changes:
            changes = [{"path": relative(path, workspace), "action": "add" if tool == "write" else "update"}]
        out = event_base("opencode", "pre_edit", workspace, record.get("sessionID", ""))
        out.update({"tool_name": tool, "tool_id": tool_id,
                    "paths": changes,
                    "added_content": []})
        return [out]
    if tool == "bash":
        command = args.get("command") or ""
        out = event_base("opencode", "pre_command", workspace, record.get("sessionID", ""))
        out.update({"tool_name": tool, "tool_id": tool_id, "command": command})
        records = [out]
        metadata_exit = (state.get("metadata") or {}).get("exit")
        native_status = state.get("status")
        if is_check(command) and isinstance(metadata_exit, (int, float)) and not isinstance(metadata_exit, bool):
            records.append({"record_type": "check", "command": command, "status": metadata_exit})
        elif is_check(command) and native_status in {"completed", "error"}:
            records.append({"record_type": "check", "command": command,
                            "status": 1 if native_status == "error" else 0})
        return records
    return []


def main() -> int:
    if len(sys.argv) != 6:
        return 2
    runtime, transcript, output, workspace, hook_trace = sys.argv[1:]
    pending: dict[str, str] = {}
    normalized: list[dict[str, Any]] = []
    try:
        lines = Path(transcript).read_text(errors="replace").splitlines()
    except OSError:
        return 4
    for line in lines:
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        if runtime == "codex":
            events = codex(record, workspace)
        elif runtime == "claude":
            events = claude(record, workspace, pending)
        elif runtime == "opencode":
            events = opencode(record, workspace)
        else:
            events = []
        normalized.extend(events)
    if not normalized:
        return 4
    reconcile_checks(normalized, fixture_checks(hook_trace))
    with open(output, "w", encoding="utf-8") as target:
        for event in normalized:
            target.write(json.dumps(event, separators=(",", ":")) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

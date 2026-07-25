#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "evals/lib/normalize_transcript.py"
FIXTURES = ROOT / "evals/fixtures/transcripts"
SPEC = importlib.util.spec_from_file_location("normalize_transcript", SCRIPT)
assert SPEC and SPEC.loader
NORMALIZE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(NORMALIZE)


def records(name: str) -> list[dict]:
    return [json.loads(line) for line in (FIXTURES / name).read_text().splitlines()]


class TranscriptEvidenceTests(unittest.TestCase):
    def test_only_actual_python_checks_are_recognized(self) -> None:
        accepted = [
            "python check.py",
            "python3 ./check.py -q",
            "/usr/bin/python3 -m unittest discover -q",
            "cd src && env CI=1 timeout 30 python3 check.py",
            "uv run python3 -m unittest",
        ]
        rejected = [
            "cat check.py",
            "sed -n '1,80p' check.py",
            "rg check.py .",
            "echo python3 check.py",
            "python3 -c check.py",
        ]
        self.assertTrue(all(NORMALIZE.is_check(command) for command in accepted))
        self.assertFalse(any(NORMALIZE.is_check(command) for command in rejected))

    def test_claude_uses_is_error_without_output_heuristics(self) -> None:
        pending: dict[str, str] = {}
        events = [event for record in records("claude.jsonl")
                  for event in NORMALIZE.claude(record, "/tmp/workspace", pending)]
        checks = [event for event in events if event.get("record_type") == "check"]
        self.assertEqual([check["status"] for check in checks], [0, 1])
        self.assertEqual(len(checks), 2)

    def test_codex_uses_exit_code_and_ignores_searches(self) -> None:
        events = [event for record in records("codex.jsonl")
                  for event in NORMALIZE.codex(record, "/tmp/workspace")]
        checks = [event for event in events if event.get("record_type") == "check"]
        self.assertEqual([check["status"] for check in checks], [0, 2])
        self.assertEqual(len(checks), 2)

    def test_opencode_prefers_numeric_exit_then_native_state(self) -> None:
        events = [event for record in records("opencode.jsonl")
                  for event in NORMALIZE.opencode(record, "/tmp/workspace")]
        checks = [event for event in events if event.get("record_type") == "check"]
        self.assertEqual([check["status"] for check in checks], [5, 0, 1])
        self.assertEqual(len(checks), 3)

    def test_fixture_statuses_override_in_place_without_reordering(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "events.jsonl"
            result = subprocess.run(
                [sys.executable, str(SCRIPT), "claude", str(FIXTURES / "claude.jsonl"),
                 str(output), "/tmp/workspace", str(FIXTURES / "authoritative-checks.jsonl")],
                check=False,
            )
            self.assertEqual(result.returncode, 0)
            events = [json.loads(line) for line in output.read_text().splitlines()]
        self.assertEqual(
            [event.get("record_type", event.get("event")) for event in events],
            ["pre_command", "check", "pre_command", "check", "pre_command"],
        )
        self.assertEqual(
            [event["status"] for event in events if event.get("record_type") == "check"],
            [4, 0],
        )


if __name__ == "__main__":
    unittest.main()

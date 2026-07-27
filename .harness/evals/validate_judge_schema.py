#!/usr/bin/env python3
"""Validate evals/judge.schema.json and its checked-in fixtures.

Run from anywhere: python3 evals/validate_judge_schema.py
Requires the `jsonschema` package (pip install jsonschema) — installed on demand by
the CI `schema` job, not vendored as a repo dependency since this harness ships with
zero Python/Node dependencies otherwise.

Checks:
  1. evals/judge.schema.json is itself a valid JSON Schema (Draft 2020-12).
  2. Every fixture under evals/fixtures/judge/valid-*.json validates successfully.
  3. Every fixture under evals/fixtures/judge/invalid-*.json fails validation —
     a schema with no negative fixture can silently rot into a no-op.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from jsonschema import Draft202012Validator
from jsonschema.exceptions import SchemaError, ValidationError

ROOT = Path(__file__).resolve().parents[1]
SCHEMA_PATH = ROOT / "evals" / "judge.schema.json"
FIXTURES_DIR = ROOT / "evals" / "fixtures" / "judge"


def fail(message: str) -> None:
    print(f"FAIL: {message}", file=sys.stderr)
    sys.exit(1)


def main() -> None:
    schema = json.loads(SCHEMA_PATH.read_text())

    try:
        Draft202012Validator.check_schema(schema)
    except SchemaError as exc:
        fail(f"{SCHEMA_PATH} is not a valid JSON Schema: {exc}")
    print(f"PASS: {SCHEMA_PATH.relative_to(ROOT)} is a valid JSON Schema")

    validator = Draft202012Validator(schema)

    valid_fixtures = sorted(FIXTURES_DIR.glob("valid-*.json"))
    invalid_fixtures = sorted(FIXTURES_DIR.glob("invalid-*.json"))

    if not valid_fixtures:
        fail(f"no valid-*.json fixtures found under {FIXTURES_DIR}")
    if not invalid_fixtures:
        fail(f"no invalid-*.json fixtures found under {FIXTURES_DIR} "
             "(a schema with no negative fixture can silently rot into a no-op)")

    for fixture in valid_fixtures:
        instance = json.loads(fixture.read_text())
        errors = list(validator.iter_errors(instance))
        if errors:
            fail(f"{fixture.relative_to(ROOT)} was expected to validate but did not: "
                 f"{errors[0].message}")
        print(f"PASS: {fixture.relative_to(ROOT)} validates against the schema")

    for fixture in invalid_fixtures:
        instance = json.loads(fixture.read_text())
        errors = list(validator.iter_errors(instance))
        if not errors:
            fail(f"{fixture.relative_to(ROOT)} was expected to FAIL validation but "
                 "passed — the schema may have regressed")
        print(f"PASS: {fixture.relative_to(ROOT)} correctly fails validation "
              f"({len(errors)} violation(s))")

    print("validate_judge_schema.py: all checks passed")


if __name__ == "__main__":
    try:
        main()
    except (ValidationError, OSError, json.JSONDecodeError) as exc:
        fail(str(exc))

#!/usr/bin/env python3
"""scan_with_health.py — `aios-ingest scan` with `metrics.codebase_health` attached (AIO-608).

Used ONLY by the opt-in path of .github/workflows/scan-on-merge.yml (repo variable
AIOS_PUSH_CODEBASE_HEALTH=1). It reuses the ingestion sidecar's own analyzer + client
(installed from aios-team-brain in the preceding workflow step) so the brain receives the
SAME full-metrics payload `aios-ingest scan` would send, plus the contract-shaped
`codebase_health` object produced by scripts/codebase-health/push-payload.mjs. A sparse
health-only payload is never sent — the brain 422s it and the metrics upsert REPLACES the
(codebase_id, head_sha) row, so health must always ride on the full block.

Health is opt-in ENRICHMENT, never a gate: if the health file is unreadable, off-contract,
or describes a different head, the attachment is skipped with a warning and the base scan
is pushed anyway — base telemetry must never be lost to a health problem.

Auth is identical to `aios-ingest scan`: BrainSettings.from_env() (BRAIN_URL / AIOS_API_KEY /
AIOS_TEAM) + optional GITHUB_TOKEN for enrichment. No new credentials, no flags for secrets.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys

from aios_ingest.analyzers import analyze_repo
from aios_ingest.brain_client import BrainClient
from aios_ingest.config import BrainSettings

# Mirrors docs/contract/codebase-payload-1.15.schema.json $defs.codebaseHealth.required.
CONTRACT_FIELDS = {
    "schema_version",
    "rubric_version",
    "head_sha",
    "score_pct",
    "status",
    "dimensions",
    "failed_invariant_ids",
    "measured_at",
}


def _skip(reason: str) -> None:
    print(f"codebase_health: {reason} — pushing the base scan WITHOUT health", file=sys.stderr)


def load_health(path: str) -> dict | None:
    """Read + shape-check the mapped health JSON. Any problem → warn and return None
    (the caller then pushes the plain scan; a health failure never drops base telemetry)."""
    try:
        with open(path, encoding="utf-8") as fh:
            health = json.load(fh)
    except (OSError, ValueError) as exc:  # ValueError covers JSONDecodeError
        _skip(f"cannot read health JSON {path!r}: {exc}")
        return None
    if not isinstance(health, dict):
        _skip("health JSON is not an object")
        return None
    missing = CONTRACT_FIELDS - set(health)
    extra = set(health) - CONTRACT_FIELDS
    if missing or extra:
        _skip(
            f"health JSON does not match the 1.15 contract "
            f"(missing={sorted(missing)}, extra={sorted(extra)})"
        )
        return None
    return health


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--path", default=".", help="local git checkout to analyze")
    ap.add_argument("--slug", required=True, help="codebase slug (unique per team)")
    ap.add_argument("--full-name", default="", help="owner/repo for GitHub enrichment")
    ap.add_argument("--window", type=int, default=90, help="analysis window in days")
    ap.add_argument(
        "--health-json",
        required=True,
        help="contract-shaped codebase_health JSON (push-payload.mjs output)",
    )
    args = ap.parse_args()

    health = load_health(args.health_json)

    settings = BrainSettings.from_env()
    token = os.environ.get("GITHUB_TOKEN")  # read from env only; never logged
    payload = analyze_repo(
        args.path,
        slug=args.slug,
        full_name=args.full_name,
        window_days=args.window,
        github_token=token,
    )

    if health is not None:
        scan_sha = payload["metrics"].get("head_sha")
        if health["head_sha"] != scan_sha:
            _skip(
                f"health head_sha {health['head_sha']} != scanned head_sha {scan_sha} "
                "(snapshot of a different commit)"
            )
        else:
            payload["metrics"]["codebase_health"] = health

    async def run() -> None:
        async with BrainClient(settings.base_url, settings.api_key, settings.team) as client:
            print(json.dumps(await client.push_codebase_scan(payload)))

    m = payload["metrics"]
    health_note = (
        f"{m['codebase_health']['status']} ({m['codebase_health']['score_pct']}%)"
        if "codebase_health" in m
        else "not attached"
    )
    print(
        f"scanned {args.slug}: {m['commits_window']} commits "
        f"({m['ai_commits_window']} AI-assisted), codebase_health={health_note}"
    )
    asyncio.run(run())


if __name__ == "__main__":
    main()

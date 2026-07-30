#!/usr/bin/env python3
"""scan_with_health.py — `aios-ingest scan` with `metrics.codebase_health` attached (AIO-608).

Used ONLY by the opt-in path of .github/workflows/scan-on-merge.yml (repo variable
AIOS_PUSH_CODEBASE_HEALTH=1). It reuses the ingestion sidecar's own analyzer + client
(installed from aios-team-brain in the preceding workflow step) so the brain receives the
SAME full-metrics payload `aios-ingest scan` would send, plus the contract-shaped
`codebase_health` object produced by scripts/codebase-health/push-payload.mjs. A sparse
health-only payload is never sent — the brain 422s it and the metrics upsert REPLACES the
(codebase_id, head_sha) row, so health must always ride on the full block.

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

    with open(args.health_json, encoding="utf-8") as fh:
        health = json.load(fh)
    missing = CONTRACT_FIELDS - set(health)
    extra = set(health) - CONTRACT_FIELDS
    if missing or extra:
        sys.exit(
            f"health JSON does not match the 1.15 contract (missing={sorted(missing)}, "
            f"extra={sorted(extra)}) — refusing to attach; run the plain scan instead"
        )

    settings = BrainSettings.from_env()
    token = os.environ.get("GITHUB_TOKEN")  # read from env only; never logged
    payload = analyze_repo(
        args.path,
        slug=args.slug,
        full_name=args.full_name,
        window_days=args.window,
        github_token=token,
    )

    scan_sha = payload["metrics"].get("head_sha")
    if health["head_sha"] != scan_sha:
        sys.exit(
            f"health head_sha {health['head_sha']} != scanned head_sha {scan_sha} — "
            "refusing to attach a snapshot of a different commit"
        )
    payload["metrics"]["codebase_health"] = health

    async def run() -> None:
        async with BrainClient(settings.base_url, settings.api_key, settings.team) as client:
            print(json.dumps(await client.push_codebase_scan(payload)))

    m = payload["metrics"]
    print(
        f"scanned {args.slug}: {m['commits_window']} commits "
        f"({m['ai_commits_window']} AI-assisted), codebase_health="
        f"{health['status']} ({health['score_pct']}%)"
    )
    asyncio.run(run())


if __name__ == "__main__":
    main()

#!/bin/bash
# scaffold-engagement.sh — back-compat shim.
# The scaffold now lives in scaffold-project.sh; this preserves the legacy
# consulting layout (00-engagement/, 04-client-surface/, engagement.yaml).
exec "$(cd "$(dirname "$0")" && pwd)/scaffold-project.sh" --profile engagement "$@"

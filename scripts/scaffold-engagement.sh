#!/bin/bash
# scaffold-engagement.sh — back-compat shim.
# The scaffold now lives in scaffold-project.sh and is context-driven. The legacy
# `engagement` profile maps to the `consultant` context (client-facing spine).
# Prefer: scaffold-project.sh --context consultant
exec "$(cd "$(dirname "$0")" && pwd)/scaffold-project.sh" --context consultant "$@"

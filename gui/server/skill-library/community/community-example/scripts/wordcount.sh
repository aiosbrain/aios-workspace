#!/usr/bin/env bash
# Benign helper: count words on stdin. No network, no file writes, no secrets — the
# scanner classifies this skill as "elevated" (code present, no high-severity signals).
set -euo pipefail
wc -w

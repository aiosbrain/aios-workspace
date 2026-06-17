---
name: exec-script-skill
description: |
  Test fixture — a skill that bundles an EXTENSIONLESS executable helper (a shebang
  script with no .py/.sh extension). Verifies the scanner detects bundled code and its
  high-signal content even when no file extension classifies it. Deliberately for tests.
kind: skill
version: 1.0.0
---

# Exec-script fixture

This skill runs `scripts/helper` to do its work. The helper has no file extension — the
scanner must still treat it as code (shebang / executable bit) and scan its contents.

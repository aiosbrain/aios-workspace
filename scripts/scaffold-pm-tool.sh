#!/bin/bash
# scaffold-pm-tool.sh — record this workspace's PM tool and stamp the assets it selects.
#
# SOURCED by scaffold-project.sh (not executed), so it runs in the parent shell and reads
# $PM_TOOL / $OUTPUT / $REPO_ROOT directly — no exports needed. Extracted rather than inlined
# because scaffold-project.sh is at its size-cap ratchet (scripts/size-caps.json), the same
# reason scaffold-repo-meta.sh exists.
#
# `pm_tool` (aios.yaml) is the seam that keeps Linear-specific governance out of a workspace
# whose team does not use Linear (AIO-844). It gates four assets, and only these four:
#   .claude/rules/linear-factory.md
#   .claude/skills/aios-linear/
#   docs/agentic-ergonomics/aios-issue-template.md
#   docs/agentic-ergonomics/aios-finding-template.md
# The spec-readiness rubric is deliberately NOT gated — grading a spec is PM-tool-agnostic,
# and every workspace needs it for `aios spec eval`.
#
# `aios update` enforces the same rule independently, via the `pmTool` field on MANAGED_PATHS
# (scripts/toolkit-manifest.mjs). The two are separate implementations of one rule — bash here,
# JS there — with no shared abstraction between them; change both together.

# Ask only when the caller did not answer with --pm-tool, and only on a real terminal, exactly
# mirroring the CI_WORKFLOW prompt's guard. A non-interactive scaffold (CI, a test harness)
# records the default rather than blocking on a question nobody can answer.
if [ -z "$PM_TOOL" ] && [ -t 0 ] && [ -t 1 ]; then
  printf "Which PM tool does this workspace use? [linear/clickup/none, default: linear]: "
  read -r PM_TOOL_ANS || PM_TOOL_ANS=""
  PM_TOOL="$PM_TOOL_ANS"
fi

# Anything unrecognized (including empty) falls back to linear: it is the only tool with a
# working implementation, so an unrecognized answer must not silently strip the harness.
case "$PM_TOOL" in
  linear|clickup|none) : ;;
  *) PM_TOOL="linear" ;;
esac

# Appended rather than templated: the prompt runs after process_template has already written
# aios.yaml. Same mechanism as `ci_workflow`, and it keeps the flat-scalar shape OGR04 requires.
echo "pm_tool: $PM_TOOL" >> "$OUTPUT/aios.yaml"

# The rubric `linear-factory.md` and `aios spec eval` both grade against. Ungated, and copied
# from the canonical toolkit copy (not scaffold/) so there is only ever one to keep current.
cp "$REPO_ROOT/.claude/rubrics/spec-readiness.md" "$OUTPUT/.claude/rubrics/spec-readiness.md"

if [ "$PM_TOOL" = "linear" ]; then
  # The canonical issue template. resolveLinearTemplate() (scripts/connectors/linear/
  # template.mjs, AIO-1067) resolves this path from the workspace cwd, so
  # `aios linear create --template aios` is inert without it.
  mkdir -p "$OUTPUT/docs/agentic-ergonomics"
  cp "$REPO_ROOT/docs/agentic-ergonomics/aios-issue-template.md" \
    "$OUTPUT/docs/agentic-ergonomics/aios-issue-template.md"
  # The finding-shaped sibling (AIO-999): `linear.mjs create --template finding`.
  cp "$REPO_ROOT/docs/agentic-ergonomics/aios-finding-template.md" \
    "$OUTPUT/docs/agentic-ergonomics/aios-finding-template.md"
else
  # Copy-then-prune: the wholesale rules/skills copies above already ran. Pruning two paths
  # beats converting those copies into curated file lists that would need every one of the
  # nine rules and nineteen skills enumerated — and would silently drop a tenth added later.
  rm -f "$OUTPUT/.claude/rules/linear-factory.md"
  rm -rf "$OUTPUT/.claude/skills/aios-linear"
fi

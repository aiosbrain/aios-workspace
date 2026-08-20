#!/usr/bin/env bash
set -euo pipefail

readonly BRAIN_REPO_URL="https://github.com/aiosbrain/aios-team-brain.git"
readonly BRAIN_SHA="dc8ebc762c99c27ed5bbb105f2a303e813f5ed6c"
readonly TARGET="${1:-.brain-scanner}"

if [[ -e "$TARGET" ]]; then
  echo "scanner target already exists: $TARGET" >&2
  exit 1
fi

# Fetch the public repository with every ambient credential source disabled. In particular,
# do not pass GITHUB_TOKEN to git, consult credential helpers, or permit an interactive prompt.
anonymous_git() {
  env \
    -u GITHUB_TOKEN \
    -u GH_TOKEN \
    -u GIT_CONFIG_COUNT \
    GIT_CONFIG_NOSYSTEM=1 \
    GIT_CONFIG_GLOBAL=/dev/null \
    GIT_TERMINAL_PROMPT=0 \
    GIT_ASKPASS=/bin/false \
    git -c credential.helper= "$@"
}

anonymous_git init "$TARGET"
anonymous_git -C "$TARGET" remote add origin "$BRAIN_REPO_URL"
anonymous_git -C "$TARGET" sparse-checkout init --cone
anonymous_git -C "$TARGET" sparse-checkout set ingestion
anonymous_git -C "$TARGET" fetch --depth=1 --filter=blob:none origin "$BRAIN_SHA"

resolved_sha="$(anonymous_git -C "$TARGET" rev-parse 'FETCH_HEAD^{commit}')"
if [[ "$resolved_sha" != "$BRAIN_SHA" ]]; then
  echo "Team Brain fetch resolved to $resolved_sha; expected $BRAIN_SHA" >&2
  exit 1
fi

anonymous_git -C "$TARGET" checkout --detach "$BRAIN_SHA"
head_sha="$(anonymous_git -C "$TARGET" rev-parse HEAD)"
if [[ "$head_sha" != "$BRAIN_SHA" || ! -f "$TARGET/ingestion/pyproject.toml" ]]; then
  echo "Team Brain scanner checkout verification failed" >&2
  exit 1
fi

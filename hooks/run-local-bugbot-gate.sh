#!/bin/sh
# Sanitize the native hook environment before Node loads the shared Bugbot gate.
set -eu

runtime=${1:-}
case "$runtime" in
  claude | codex | cursor) ;;
  *)
    echo "usage: run-local-bugbot-gate.sh claude|codex|cursor" >&2
    exit 2
    ;;
esac

unset AIOS_BUGBOT_MODEL AIOS_BUGBOT_HOOK_NONCE
unset NODE_OPTIONS NODE_PATH NODE_EXTRA_CA_CERTS
unset LD_PRELOAD LD_LIBRARY_PATH DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH
unset BASH_ENV ENV CDPATH
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY
unset GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_EXTERNAL_DIFF GIT_DIFF_OPTS
unset GIT_CONFIG_COUNT GIT_CONFIG_GLOBAL GIT_CONFIG_SYSTEM GIT_CONFIG_NOSYSTEM
unset GIT_CONFIG_PARAMETERS GIT_EXEC_PATH GIT_PROXY_COMMAND
unset GIT_SSH GIT_SSH_COMMAND GIT_ASKPASS SSH_ASKPASS
unset GIT_SSL_NO_VERIFY GIT_SSL_CAINFO GIT_SSL_CAPATH
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY
unset http_proxy https_proxy all_proxy no_proxy
unset SSL_CERT_FILE SSL_CERT_DIR

root=${2:?project root is required}

node_bin=""
for candidate in \
  /opt/homebrew/opt/node/bin/node \
  /opt/homebrew/bin/node \
  /usr/local/bin/node \
  /usr/bin/node; do
  if [ -x "$candidate" ] && "$candidate" --version >/dev/null 2>&1; then
    node_bin=$candidate
    break
  fi
done
if [ -z "$node_bin" ]; then
  echo "required trusted Node binary not found" >&2
  exit 1
fi

PATH=/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin
export PATH

cd "$root"
exec "$node_bin" "$root/hooks/local-bugbot-gate.mjs" --runtime "$runtime"

# Executor v1.5.33 Docker wrong-key matrix

**Captured:** 2026-07-14 UTC
**Executor:** `v1.5.33`, source commit
`0a50c796c2cc334cf3e9bf6d4be33c77dbfac93b`
**Image:** `ghcr.io/usefulsoftwareco/executor-selfhost:v1.5.33` at
`sha256:2f1e9fd6e5253fcbf8b176689174d6d8c8774869cdfce253ec71ab4ddb604774`
**Docker:** client/server `28.5.1`

The run used fresh, locally generated disposable encryption keys, an authentication secret,
bootstrap credentials under `invalid.example`, and a random sentinel. No GitHub PAT,
production credential, team credential, or external GitHub request was used. Values and key
fingerprints were destroyed with the shell and are not retained here.

| case | UTC time | image/source digest | command label | exit code | classification | plaintext fallback |
|---|---|---|---|---:|---|---|
| correct-key | 2026-07-14T08:12:12Z | image sha256:2f1e9fd6e5253fcbf8b176689174d6d8c8774869cdfce253ec71ab4ddb604774; source 0a50c796c2cc334cf3e9bf6d4be33c77dbfac93b | assert-original-key-resolution-before-ssrf | 0 | success | false |
| wrong-key | 2026-07-14T08:12:14Z | image sha256:2f1e9fd6e5253fcbf8b176689174d6d8c8774869cdfce253ec71ab4ddb604774; source 0a50c796c2cc334cf3e9bf6d4be33c77dbfac93b | invoke-after-secret-key-change | 1 | decryption failure | false |
| restored-key | 2026-07-14T08:12:16Z | image sha256:2f1e9fd6e5253fcbf8b176689174d6d8c8774869cdfce253ec71ab4ddb604774; source 0a50c796c2cc334cf3e9bf6d4be33c77dbfac93b | assert-restored-key-resolution-before-ssrf | 0 | recovered | false |
| private-network-ssrf | 2026-07-14T08:12:12Z | image sha256:2f1e9fd6e5253fcbf8b176689174d6d8c8774869cdfce253ec71ab4ddb604774; source 0a50c796c2cc334cf3e9bf6d4be33c77dbfac93b | invoke-private-url-under-correct-key | 1 | expected SSRF-policy rejection | false |

## Procedure and interpretation

1. A named container, `aios-executor-key-matrix`, and named volume,
   `aios-executor-key-matrix-data`, were created from the pinned image. The sentinel was saved
   through a user-owned connection backed by Executor's `encrypted` credential provider.
2. With the original `EXECUTOR_SECRET_KEY`, invoking that connection reached Executor's network
   policy. The assertion command exited `0` only after finding the private-network rejection and
   finding no decryption failure. This proves credential resolution succeeded without treating a
   deliberately blocked network request as credential success.
3. The container was removed and recreated over the same named volume with a different
   `EXECUTOR_SECRET_KEY`. Invocation failed at authenticated decryption before network policy or
   transport. No connection-credential environment variable was configured, so there was no
   plaintext or environment fallback.
4. The container was again removed and recreated over the same volume with the original key.
   The same stored credential once more reached the private-network guard, proving recovery.
5. The raw private-address invocation is recorded separately as non-zero. Its diagnostic was
   `Local and private network addresses are not allowed`; it is expected Executor SSRF policy
   behavior, not a credential failure.

Sanitized assertions from the disposable run:

```text
wrongKeyDecryptFailureBeforeNetwork=true
restoredCredentialResolution=true
loginHttp=200
addSpecHttp=200
createConnectionHttp=200
capturedLogCanaryMatches=0
recursiveVolumeFilesScanned=3
recursiveVolumeCanaryMatches=0
credentialEnvFallbackConfigured=false
container_after_cleanup=
volume_after_cleanup=
stagedDiffSentinelMatches=0
stagedDiffOriginalKeyFingerprintMatches=0
stagedDiffWrongKeyFingerprintMatches=0
exactStagedDiffSecretScan=PASS
```

## Sanitized command transcript

The shell ran with `set +x` semantics: generated values were held only in shell variables and JSON
request files under a mode-`0700` temporary directory. The following is the retained command
skeleton with values replaced by variable names. It preserves the actual sequence and flags; it
is not a pasteable source of credentials.

```sh
set +x
umask 077
export IMAGE=ghcr.io/usefulsoftwareco/executor-selfhost:v1.5.33
export NAME=aios-executor-key-matrix
export VOLUME=aios-executor-key-matrix-data
# The live runner asserted the exact isolated worktree here; its machine-local absolute path is
# intentionally redacted from retained evidence.
test "$(basename "$(git rev-parse --show-toplevel)")" = feat-aio-400-executor-gateway-docs
if docker container inspect "$NAME" >/dev/null 2>&1; then exit 1; fi
if docker volume inspect "$VOLUME" >/dev/null 2>&1; then exit 1; fi
OWNED_CONTAINER=0
OWNED_VOLUME=0
export ORIGINAL_KEY="$(openssl rand -base64 48)"
export WRONG_KEY="$(openssl rand -base64 48)"
export BETTER_AUTH_SECRET="$(openssl rand -base64 48)"
export EXECUTOR_BOOTSTRAP_ADMIN_EMAIL="spike-$(openssl rand -hex 6)@invalid.example"
read -r EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD < <(openssl rand -hex 32)
export EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD
export SENTINEL="aio400-sentinel-$(openssl rand -hex 24)"
export ORIGINAL_KEY_FP="$(printf %s "$ORIGINAL_KEY" | shasum -a 256 | awk '{print $1}')"
export WRONG_KEY_FP="$(printf %s "$WRONG_KEY" | shasum -a 256 | awk '{print $1}')"
TMPD="$(mktemp -d /tmp/aio400-matrix-live.XXXXXX)"

cleanup_owned() {
  if [ "$OWNED_CONTAINER" = 1 ]; then docker rm -f "$NAME"; fi
  if [ "$OWNED_VOLUME" = 1 ]; then docker volume rm "$VOLUME"; fi
}
trap cleanup_owned EXIT INT TERM

start_container() {
  export EXECUTOR_SECRET_KEY="$1"
  docker run -d --name "$NAME" -p 127.0.0.1:14788:4788 \
    -e EXECUTOR_SECRET_KEY -e BETTER_AUTH_SECRET \
    -e EXECUTOR_BOOTSTRAP_ADMIN_EMAIL -e EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD \
    -v "$VOLUME:/data" "$IMAGE"
  OWNED_CONTAINER=1
  until curl -sS -o /dev/null -f http://127.0.0.1:14788/api/health; do sleep 1; done
}
invoke() {
  curl -sS -b "$TMPD/cookies" -o "$TMPD/invoke.out" \
    -H 'content-type: application/json' --data-binary @"$TMPD/execution.json" \
    http://127.0.0.1:14788/api/executions
}

docker volume create "$VOLUME"
OWNED_VOLUME=1
start_container "$ORIGINAL_KEY"
node - "$TMPD/login.json" "$TMPD/spec.json" "$TMPD/connection.json" \
  "$TMPD/execution.json" <<'NODE'
const fs = require("fs");
const spec = {
  openapi: "3.0.3",
  info: { title: "Disposable sentinel API", version: "1.0.0" },
  servers: [{ url: "http://127.0.0.1:9" }],
  paths: { "/sentinel": { get: { operationId: "readSentinel",
    responses: { "200": { description: "ok" } } } } },
  components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } },
  security: [{ bearerAuth: [] }]
};
fs.writeFileSync(process.argv[2], JSON.stringify({
  email: process.env.EXECUTOR_BOOTSTRAP_ADMIN_EMAIL,
  password: process.env.EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD
}));
fs.writeFileSync(process.argv[3], JSON.stringify({
  spec: { kind: "blob", value: JSON.stringify(spec) }, slug: "aio400-sentinel",
  name: "AIO400 sentinel", baseUrl: "http://127.0.0.1:9"
}));
fs.writeFileSync(process.argv[4], JSON.stringify({
  owner: "user", name: "matrix", integration: "aio400-sentinel",
  template: "apikey-0", value: process.env.SENTINEL
}));
fs.writeFileSync(process.argv[5], JSON.stringify({
  code: 'return await tools["aio400-sentinel.user.matrix.sentinel.readSentinel"]({});'
}));
NODE
curl -sS -c "$TMPD/cookies" -o "$TMPD/login.out" -H 'content-type: application/json' \
  --data-binary @"$TMPD/login.json" http://127.0.0.1:14788/api/auth/sign-in/email
curl -sS -b "$TMPD/cookies" -o "$TMPD/spec.out" -H 'content-type: application/json' \
  --data-binary @"$TMPD/spec.json" http://127.0.0.1:14788/api/openapi/specs
curl -sS -b "$TMPD/cookies" -o "$TMPD/connection.out" -H 'content-type: application/json' \
  --data-binary @"$TMPD/connection.json" http://127.0.0.1:14788/api/connections
invoke
docker logs "$NAME" >"$TMPD/correct.log" 2>&1
docker rm -f "$NAME"
OWNED_CONTAINER=0

start_container "$WRONG_KEY"
invoke
docker logs "$NAME" >"$TMPD/wrong.log" 2>&1
docker rm -f "$NAME"
OWNED_CONTAINER=0

start_container "$ORIGINAL_KEY"
invoke
docker logs "$NAME" >"$TMPD/restored.log" 2>&1

# The actual run recursively walked every regular file under /data (including WAL/SHM or other
# sidecars when present) and searched raw bytes for the exact sentinel.
S="$SENTINEL" docker run --rm -e S -v "$VOLUME:/scan:ro" \
  --entrypoint /usr/local/bin/bun "$IMAGE" -e '
const fs=require("fs"),path=require("path"); let files=0,matches=0;
const needle=Buffer.from(process.env.S);
const walk=p=>{for(const e of fs.readdirSync(p,{withFileTypes:true})){
  const q=path.join(p,e.name); if(e.isDirectory()) walk(q); else if(e.isFile()){
    files++; const b=fs.readFileSync(q); let at=0;
    while((at=b.indexOf(needle,at))!==-1){matches++; at+=needle.length;}
  }
}};
walk("/scan"); console.log(JSON.stringify({files,matches}));'
# Result: {"files":3,"matches":0}. All three captured log files also had zero exact matches.

docker rm -f "$NAME"
OWNED_CONTAINER=0
docker volume rm "$VOLUME"
OWNED_VOLUME=0
docker ps -a --filter name="$NAME" --format '{{.Names}}'
docker volume ls --filter name="$VOLUME" --format '{{.Name}}'

# After all six declared documentation/evidence/contract paths are staged, while values remain only in
# this isolated shell:
STAGED="$(git diff --cached --no-ext-diff --binary)"
printf %s "$STAGED" | grep -F -c "$SENTINEL"
printf %s "$STAGED" | grep -F -c "$ORIGINAL_KEY_FP"
printf %s "$STAGED" | grep -F -c "$WRONG_KEY_FP"
unset ORIGINAL_KEY WRONG_KEY BETTER_AUTH_SECRET EXECUTOR_BOOTSTRAP_ADMIN_EMAIL \
  EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD SENTINEL ORIGINAL_KEY_FP WRONG_KEY_FP
rm -rf "$TMPD"
```

Numeric command outcomes and redacted diagnostics:

```text
[correct-key] assert-original-key-resolution-before-ssrf exit=0
reason: "Local and private network addresses are not allowed"
decryption-error match count: 0

[private-network-ssrf] invoke-private-url-under-correct-key exit=1
request: GET http://127.0.0.1:9/sentinel
classification: expected SSRF-policy rejection

[wrong-key] invoke-after-secret-key-change exit=1
error: "Failed to decrypt secret"
classification: decryption failure
private-network-policy match count: 0

[restored-key] assert-restored-key-resolution-before-ssrf exit=0
reason: "Local and private network addresses are not allowed"
decryption-error match count: 0
```

The first and restored assertions return success only when the SSRF diagnostic is present and the
decryption diagnostic is absent. The wrong-key assertion returns non-zero only when decryption
fails and the network-policy diagnostic is absent. Thus the transcript distinguishes credential
resolution from the downstream private-network guard rather than treating either error as generic
success.

Only the two named resources were removed. No Docker prune command was used. Post-cleanup checks:

```sh
docker ps -a --filter name=aios-executor-key-matrix --format '{{.Names}}'
docker volume ls --filter name=aios-executor-key-matrix-data --format '{{.Name}}'
```

Both commands exited `0` and produced empty output.

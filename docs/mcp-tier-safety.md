# MCP authorization acceptance (AIO-1109)

The offline protocol suite (`node scripts/brain-mcp.test.mjs`) does not prove
authorization. The separate network suite launches the actual MCP process over
stdio against the production Brain HTTP harness and real Postgres. The canonical
test inventory lists this under `network`, separately from offline Node tests.

Install the pinned Brain checkout's development dependencies, then run:

```sh
MCP_BRAIN_DIR=/absolute/path/to/aios-team-brain \
MCP_BRAIN_SHA=1a2ca61fd39003f3a72b5cdf4beb39ae5dfe32f7 \
node scripts/test-mcp-tier-safety.mjs
```

Docker and Node 22 are required. No production or durable staging credentials
are used. Each build is extracted from the exact Brain commit, with its own
production output and fresh Docker-assigned Postgres port. The test-support
companion uses canonical key issuance, ingestion and access helpers. Control
commands travel on parent/child IPC, never a production HTTP endpoint.

The assertions require visible content; an empty response cannot pass. An external
member without extra grants sees external-shared content. Explicit project grants
make their project content visible, including team-access items; revocation removes
it. Direct Brain requests must agree with MCP. The board case initializes with team
posture, removes team membership, confirms `/me` reports external, and observes
the Brain's 403 through the still-listed tool in the same process.

Two independent disposable source mutations bypass project-route denial and item
visibility enforcement. Each must reach and fail its named MCP outcome assertion.
A failed build, failed startup, missing infrastructure, or cleanup error cannot
count as a successful mutation control. Fixtures are explicitly deleted and their
absence checked; the process and database must also be removed on failure.

`.tmp/mcp-tier-evidence/` holds build/schema/test logs and a manifest with candidate
SHAs, mutation digests, test-log SHA-256 values and cleanup outcomes. CI uploads it
on success and failure. Record verified evidence on AIO-1109 before AIO-1110 starts.
A baseline authorization failure must be investigated: a confirmed production defect
gets a separate blocking fix issue and stops the release dependency chain.

import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_API_RESPONSE_BYTES,
  MAX_ARCHIVE_BYTES,
  resolveCoverageArtifact,
  selectExactArtifact,
  selectExactRun,
} from "../scripts/resolve-coverage-artifact.mjs";

const EXPECTED = Object.freeze({
  repository: "aiosbrain/aios-workspace",
  repositoryId: "1259989678",
  sha: "a".repeat(40),
});

function run(overrides = {}) {
  return {
    id: 34211847359,
    event: "push",
    head_branch: "main",
    head_sha: EXPECTED.sha,
    head_repository: { id: 1259989678, full_name: EXPECTED.repository },
    path: ".github/workflows/ci.yml",
    ...overrides,
  };
}

function artifact(overrides = {}) {
  return {
    id: 10050195342,
    name: "coverage-bundle",
    expired: false,
    size_in_bytes: 341259,
    workflow_run: {
      id: 34211847359,
      repository_id: 1259989678,
      head_repository_id: 1259989678,
      head_branch: "main",
      head_sha: EXPECTED.sha,
    },
    ...overrides,
  };
}

test("selects only the exact push/main/ci.yml repository and SHA run", () => {
  const selected = selectExactRun(
    {
      workflow_runs: [
        run({ event: "pull_request" }),
        run({ head_sha: "b".repeat(40) }),
        run({ path: ".github/workflows/other.yml" }),
        run(),
      ],
    },
    EXPECTED
  );
  assert.equal(selected.id, 34211847359);
  assert.throws(
    () => selectExactRun({ workflow_runs: [run(), run({ id: 34211847360 })] }, EXPECTED),
    /multiple exact/
  );
});

test("artifact selection binds run, repository, SHA, branch, expiry, and byte ceiling", () => {
  assert.equal(selectExactArtifact({ artifacts: [artifact()] }, run(), EXPECTED).id, 10050195342);
  for (const value of [
    artifact({ expired: true }),
    artifact({ size_in_bytes: MAX_ARCHIVE_BYTES + 1 }),
    artifact({ workflow_run: { ...artifact().workflow_run, head_sha: "b".repeat(40) } }),
    artifact({ workflow_run: { ...artifact().workflow_run, repository_id: 9 } }),
  ]) {
    assert.throws(() => selectExactArtifact({ artifacts: [value] }, run(), EXPECTED));
  }
});

test("resolver waits boundedly for the exact artifact and never exposes the token", async () => {
  const responses = [
    { workflow_runs: [] },
    { workflow_runs: [run()] },
    { artifacts: [] },
    { workflow_runs: [run()] },
    { artifacts: [artifact()] },
  ];
  const calls = [];
  const sleeps = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const body = responses.shift();
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  const resolved = await resolveCoverageArtifact({
    fetchImpl,
    sleep: async (milliseconds) => sleeps.push(milliseconds),
    apiUrl: "https://api.github.com",
    token: "disposable-test-token",
    expected: EXPECTED,
    attempts: 3,
    delayMs: 1,
  });
  assert.equal(resolved.run.id, 34211847359);
  assert.equal(resolved.artifact.id, 10050195342);
  assert.deepEqual(sleeps, [1, 1]);
  assert.equal(
    calls.every((call) => !call.url.includes("disposable-test-token")),
    true
  );
  assert.match(calls[0].url, new RegExp(`head_sha=${EXPECTED.sha}(?:&|$)`));
  assert.equal(
    calls.every((call) => call.options.headers.Authorization === "Bearer disposable-test-token"),
    true
  );
});

test("resolver fails closed after the configured wait and on API failure", async () => {
  const emptyFetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ workflow_runs: [] }),
  });
  await assert.rejects(
    resolveCoverageArtifact({
      fetchImpl: emptyFetch,
      sleep: async () => {},
      apiUrl: "https://api.github.com",
      token: "test",
      expected: EXPECTED,
      attempts: 2,
      delayMs: 0,
    }),
    /did not become available/
  );

  await assert.rejects(
    resolveCoverageArtifact({
      fetchImpl: async () => ({ ok: false, status: 503, text: async () => "unavailable" }),
      apiUrl: "https://api.github.com",
      token: "do-not-print-this-token",
      expected: EXPECTED,
      attempts: 1,
      delayMs: 0,
    }),
    (error) => /HTTP 503/.test(error.message) && !error.message.includes("do-not-print-this-token")
  );

  await assert.rejects(
    resolveCoverageArtifact({
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => "x".repeat(MAX_API_RESPONSE_BYTES + 1),
      }),
      apiUrl: "https://api.github.com",
      token: "test",
      expected: EXPECTED,
      attempts: 1,
      delayMs: 0,
    }),
    /exceeds 2 MiB/
  );
});

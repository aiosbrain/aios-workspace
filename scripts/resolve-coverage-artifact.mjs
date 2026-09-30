#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const COVERAGE_ARTIFACT_NAME = "coverage-bundle";
export const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024;
export const MAX_API_RESPONSE_BYTES = 2 * 1024 * 1024;
const API_VERSION = "2022-11-28";

function fail(message) {
  throw new Error(`coverage-artifact: ${message}`);
}

function positiveInteger(value, label) {
  const normalized = String(value ?? "");
  if (!/^[1-9]\d*$/.test(normalized)) fail(`${label} must be a positive decimal integer`);
  return normalized;
}

function exactIdentity(expected) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(expected.repository ?? "")) {
    fail("repository must use owner/repository syntax");
  }
  if (!/^[0-9a-f]{40}$/.test(expected.sha ?? "")) {
    fail("sha must be a lowercase 40-character hexadecimal commit SHA");
  }
  return {
    repository: expected.repository,
    repositoryId: positiveInteger(expected.repositoryId, "repositoryId"),
    sha: expected.sha,
  };
}

export function selectExactRun(payload, expectedInput) {
  const expected = exactIdentity(expectedInput);
  if (!payload || !Array.isArray(payload.workflow_runs)) fail("runs response is malformed");
  const matches = payload.workflow_runs.filter(
    (run) =>
      run?.event === "push" &&
      run?.head_branch === "main" &&
      run?.head_sha === expected.sha &&
      String(run?.head_repository?.id ?? "") === expected.repositoryId &&
      run?.head_repository?.full_name === expected.repository &&
      run?.path === ".github/workflows/ci.yml"
  );
  if (matches.length > 1) fail("multiple exact ci.yml push runs matched the requested identity");
  if (matches.length === 0) return null;
  positiveInteger(matches[0].id, "workflow run id");
  return matches[0];
}

export function selectExactArtifact(payload, run, expectedInput) {
  const expected = exactIdentity(expectedInput);
  if (!payload || !Array.isArray(payload.artifacts)) fail("artifacts response is malformed");
  const matches = payload.artifacts.filter(
    (artifact) =>
      artifact?.name === COVERAGE_ARTIFACT_NAME &&
      String(artifact?.workflow_run?.id ?? "") === String(run.id)
  );
  if (matches.length > 1) fail("multiple coverage-bundle artifacts matched the exact run");
  if (matches.length === 0) return null;
  const artifact = matches[0];
  if (artifact.expired !== false) fail("coverage-bundle artifact is expired");
  if (!Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes < 1) {
    fail("coverage-bundle archive size must be a positive safe integer");
  }
  if (artifact.size_in_bytes > MAX_ARCHIVE_BYTES) {
    fail(`coverage-bundle archive exceeds ${MAX_ARCHIVE_BYTES} bytes`);
  }
  if (
    artifact.workflow_run?.head_branch !== "main" ||
    artifact.workflow_run?.head_sha !== expected.sha ||
    String(artifact.workflow_run?.repository_id ?? "") !== expected.repositoryId ||
    String(artifact.workflow_run?.head_repository_id ?? "") !== expected.repositoryId
  ) {
    fail("coverage-bundle producer identity does not match the requested repository and SHA");
  }
  positiveInteger(artifact.id, "artifact id");
  return artifact;
}

async function readBoundedResponse(response) {
  const declaredLength = response.headers?.get?.("content-length");
  if (declaredLength && /^\d+$/.test(declaredLength)) {
    const bytes = Number(declaredLength);
    if (!Number.isSafeInteger(bytes) || bytes > MAX_API_RESPONSE_BYTES) {
      fail("GitHub API response exceeds 2 MiB");
    }
  }

  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0;
    let text = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) fail("GitHub API returned an invalid response stream");
      bytes += value.byteLength;
      if (bytes > MAX_API_RESPONSE_BYTES) fail("GitHub API response exceeds 2 MiB");
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  }

  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_API_RESPONSE_BYTES) {
    fail("GitHub API response exceeds 2 MiB");
  }
  return text;
}

async function fetchJson(fetchImpl, url, token) {
  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": API_VERSION,
    },
  });
  let body;
  try {
    body = await readBoundedResponse(response);
  } catch (error) {
    if (error?.message?.startsWith("coverage-artifact:")) throw error;
    fail("GitHub API response could not be read as bounded UTF-8");
  }
  if (!response.ok) fail(`GitHub API returned HTTP ${response.status}`);
  try {
    return JSON.parse(body);
  } catch {
    fail("GitHub API returned invalid JSON");
  }
}

export async function resolveCoverageArtifact({
  fetchImpl = fetch,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  apiUrl,
  token,
  expected,
  attempts = 90,
  delayMs = 30_000,
}) {
  exactIdentity(expected);
  if (!/^https:\/\/api\.github\.com\/?$/.test(apiUrl ?? "")) {
    fail("apiUrl must be https://api.github.com");
  }
  if (!token) fail("GitHub token is missing");
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 120) {
    fail("attempts must be an integer from 1 to 120");
  }
  if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 60_000) {
    fail("delayMs must be an integer from 0 to 60000");
  }

  const base = apiUrl.replace(/\/$/, "");
  const workflowRunsUrl =
    `${base}/repos/${expected.repository}/actions/workflows/ci.yml/runs` +
    `?branch=main&event=push&head_sha=${expected.sha}&per_page=100`;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const runs = await fetchJson(fetchImpl, workflowRunsUrl, token);
    const run = selectExactRun(runs, expected);
    if (run) {
      const artifacts = await fetchJson(
        fetchImpl,
        `${base}/repos/${expected.repository}/actions/runs/${run.id}/artifacts?per_page=100`,
        token
      );
      const artifact = selectExactArtifact(artifacts, run, expected);
      if (artifact) return { artifact, run };
      if (run.status === "completed") {
        const conclusion = typeof run.conclusion === "string" ? run.conclusion : "unknown";
        fail(`exact-SHA coverage producer completed (${conclusion}) without coverage-bundle`);
      }
    }
    if (attempt < attempts) await sleep(delayMs);
  }
  fail("exact-SHA coverage-bundle did not become available within the bounded wait");
}

async function main(env = process.env) {
  const expected = {
    repository: env.GITHUB_REPOSITORY,
    repositoryId: env.GITHUB_REPOSITORY_ID,
    sha: env.GITHUB_SHA,
  };
  const { artifact, run } = await resolveCoverageArtifact({
    apiUrl: env.GITHUB_API_URL,
    token: env.GH_TOKEN,
    expected,
  });
  if (!env.GITHUB_OUTPUT) fail("GITHUB_OUTPUT is missing");
  appendFileSync(
    env.GITHUB_OUTPUT,
    `run-id=${run.id}\nartifact-id=${artifact.id}\narchive-bytes=${artifact.size_in_bytes}\n`
  );
  console.log(
    `coverage-artifact: verified run=${run.id} artifact=${artifact.id} bytes=${artifact.size_in_bytes}`
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

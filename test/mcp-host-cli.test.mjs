// The CLI boundary of `aios mcp install|status|uninstall`: refusals must be typed and
// actionable, yet no argv token, path or unrecognised error text may ever be rendered.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AiosError, normalizeError } from "../scripts/cli.mjs";
import { cmdMcpHost } from "../scripts/mcp-host-command.mjs";
import { typedInstallerError } from "../scripts/mcp-host-errors.mjs";
import { MCP_HOSTS } from "../scripts/mcp-hosts.mjs";
import { fixture } from "./lib/mcp-host-fixture.mjs";

const SENTINEL = "aios_k_sentinel_mcp_cli_never_print_7c41d9";
const AIOS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "aios.mjs");
// Everything a renderer could reach: message, remediation, JSON form, stack and cause chain.
function rendered(error) {
  const parts = [];
  for (let current = error; current; current = current.cause)
    parts.push(current.message, current.stack, current.remediation, JSON.stringify(current));
  return parts.join("\n");
}
async function refusal(args, options) {
  try {
    await cmdMcpHost(args, options);
  } catch (error) {
    return error;
  }
  assert.fail(`expected a refusal for: aios mcp ${args.length} argument(s)`);
}

test("a credential pasted as an option or a host is never rendered, in any error field", async (t) => {
  const f = fixture(t);
  for (const args of [
    ["install", `--api-key=${SENTINEL}`],
    ["install", "--host", "cursor", SENTINEL],
    ["install", `--host=${SENTINEL}`, "--dry-run"],
    ["install", "--host", `cursor,${SENTINEL}`],
    ["status", `--host=${SENTINEL}`],
    [`--host=${SENTINEL}`, "--uninstall"],
  ]) {
    const error = await refusal(args, f);
    assert.ok(error instanceof AiosError, "typed");
    assert.equal(error.code, "AIOS_E_USAGE");
    assert.equal(error.cause, undefined, "the unsafe original is not carried as a cause");
    assert.ok(!rendered(error).includes(SENTINEL), "sentinel absent from every rendered field");
    assert.match(
      error.remediation,
      /aios mcp install --host claude-desktop,claude-code,codex,cursor/
    );
  }
});

test("unrecognised, forged and non-plain errors stay untyped and render generically", () => {
  class Custom extends Error {}
  const system = Object.assign(new Error(`EACCES ${SENTINEL}`), { code: "EACCES" });
  for (const error of [
    new Error(`unexpected ${SENTINEL}`),
    new Error(`Cursor is running. ${SENTINEL}`),
    new Error(`Cursor is running. Quit and reopen Cursor after installation; ${SENTINEL}`),
    new Error(`Recorded MCP command did not pass initialize and tools/list (${SENTINEL})`),
    new Error(`MCP installation failed: ${SENTINEL}`, { cause: new Error(SENTINEL) }),
    new TypeError("Unknown MCP host selection"),
    new Custom("Select at least one MCP host"),
    system,
  ]) {
    assert.equal(typedInstallerError(error), error, "returned untouched");
    const generic = normalizeError(typedInstallerError(error));
    assert.equal(generic.code, "AIOS_E_INTERNAL");
    assert.ok(!`${generic.message}\n${generic.remediation}`.includes(SENTINEL));
    assert.ok(!JSON.stringify(generic).includes(SENTINEL));
  }
  const typed = new AiosError("AIOS_E_USAGE", "already typed", "remediation");
  assert.equal(typedInstallerError(typed), typed);
});

test("token- and path-bearing refusals render a trusted rebuild, never the token or path", (t) => {
  const f = fixture(t);
  const cursor = path.join(f.home, ".cursor", "mcp.json");
  for (const [message, code, expected] of [
    [`Unsupported MCP host: ${SENTINEL}`, "AIOS_E_USAGE", "Unsupported MCP host selection."],
    [
      "Unsupported MCP host: claude-desktop",
      "AIOS_E_USAGE",
      "Claude Desktop is not supported on this platform.",
    ],
    [`Invalid credential field: ${SENTINEL}`, "AIOS_E_CREDENTIAL_MISSING", /^A Brain credential/],
    ["Invalid credential field: api_key", "AIOS_E_CREDENTIAL_MISSING", /invalid: api_key\.$/],
    [
      `Brain URL protocol '${SENTINEL}:' is not allowed.`,
      "AIOS_E_CREDENTIAL_MISSING",
      /^The Brain URL/,
    ],
    [
      `Concurrent edit: ${cursor}`,
      "AIOS_E_CONFLICT",
      /^The Cursor configuration location was edited/,
    ],
    [
      `Unsafe ownership or permissions: /srv/${SENTINEL}/file`,
      "AIOS_E_CONFIG_INVALID",
      /^An installer-managed location has unsafe/,
    ],
  ]) {
    const error = typedInstallerError(new Error(message), f);
    assert.equal(error.code, code, message.slice(0, 24));
    if (typeof expected === "string") assert.equal(error.message, expected);
    else assert.match(error.message, expected);
    assert.ok(!rendered(error).includes(SENTINEL));
    assert.ok(!rendered(error).includes(f.home), "no path is rendered");
  }
  const wrapped = typedInstallerError(
    new Error(
      `MCP installation failed: Concurrent edit: ${cursor}; rollback conflicts (preserved): ${cursor}`,
      {
        cause: new Error(`Concurrent edit: ${cursor}`),
      }
    ),
    f
  );
  assert.equal(wrapped.code, "AIOS_E_CONFLICT");
  assert.match(
    wrapped.message,
    /^MCP installation failed: The Cursor configuration location .* preserved/
  );
  assert.ok(!rendered(wrapped).includes(f.home));
});

test("a running selected host stays an actionable, typed refusal for every registry host", async (t) => {
  const f = fixture(t);
  for (const host of MCP_HOSTS.filter((row) => row.candidatePaths[f.platform])) {
    const error = await refusal(["install", "--host", host.id, "--dry-run"], {
      ...f,
      runningHosts: () => [host.processes[0]],
    });
    assert.equal(error.code, "AIOS_E_CONFLICT");
    assert.equal(error.exitCode, 5);
    assert.equal(
      error.message,
      `${host.label} is running. ${host.restartText} after installation; quit it now before retrying.`
    );
    assert.match(error.remediation, /never stops an application/);
  }
  const started = await refusal(["install", "--host", "cursor"], {
    ...f,
    runningHosts: ((calls) => () => (++calls === 1 ? [] : ["Cursor"]))(0),
  });
  assert.equal(started.code, "AIOS_E_CONFLICT");
  assert.match(
    started.message,
    /^MCP installation failed: A selected host started during installation/
  );
  const unknown = await refusal(["install", "--host", "cursor"], {
    ...f,
    runningHosts: () => {
      throw new Error(`process list unavailable ${SENTINEL}`);
    },
  });
  assert.ok(!(unknown instanceof AiosError), "an unrecognised failure is not typed");
});

test("the real dispatcher renders typed usage refusals without echoing the offending token", (t) => {
  const f = fixture(t);
  const env = { PATH: path.dirname(process.execPath), HOME: f.home, USERPROFILE: f.home };
  for (const key of ["SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "APPDATA"])
    if (process.env[key] !== undefined) env[key] = process.env[key];
  if (process.platform === "win32") env.APPDATA = path.join(f.home, "AppData", "Roaming");
  for (const [args, pattern] of [
    [["install", `--api-key=${SENTINEL}`], /AIOS_E_USAGE\]?.*Unknown MCP installer option\./s],
    [
      ["install", `--host=${SENTINEL}`, "--dry-run"],
      /AIOS_E_USAGE\]?.*Unsupported MCP host selection\./s,
    ],
    [["install", `--host=${SENTINEL}`, "--dry-run", "--json"], /"code":"AIOS_E_USAGE"/],
    [["status", `--host=${SENTINEL}`], /AIOS_E_USAGE\]?.*Unknown MCP host selection/s],
    [["install", "--json"], /"code":"AIOS_E_USAGE".*Use --host /s],
  ]) {
    const result = spawnSync(process.execPath, [AIOS, "mcp", ...args], {
      cwd: f.project,
      env,
      encoding: "utf8",
      timeout: 60000,
    });
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 2, output.replaceAll(SENTINEL, "[sentinel]"));
    assert.match(output, pattern);
    assert.ok(!output.includes(SENTINEL), "sentinel absent from stdout and stderr");
    assert.ok(!output.includes("failed unexpectedly"));
  }
});

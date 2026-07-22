#!/usr/bin/env node
// test/relay-core-env.test.mjs — the build phase must strip ANTHROPIC_API_KEY from
// the spawned Claude Code child (so it uses login/subscription auth, never metered
// API billing), while the Cursor path (no env override) still inherits the parent.
// Zero-dep, no network: the "agent" is a tiny inline Node script that reports whether
// ANTHROPIC_API_KEY is present in ITS env as an assistant NDJSON line.

import { callClaudeAgent, callCursorAgent, callDeepSeekDirect } from "../scripts/relay-core.mjs";
import { writeFileSync, mkdtempSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let failed = 0;
const RED = "\x1b[0;31m",
  GREEN = "\x1b[0;32m",
  NC = "\x1b[0m";
function check(label, cond) {
  if (cond) console.log(`  ${GREEN}✓${NC} ${label}`);
  else {
    console.log(`  ${RED}✗${NC} ${label}`);
    failed++;
  }
}

// A fake agent binary: a Node script that ignores its args and emits an assistant
// NDJSON line reporting whether ANTHROPIC_API_KEY is set in its own environment.
const dir = mkdtempSync(path.join(tmpdir(), "relay-core-env-"));
const fakeBin = path.join(dir, "fake-agent.mjs");
writeFileSync(
  fakeBin,
  [
    "const key = process.env.ANTHROPIC_API_KEY ?? '<unset>';",
    "const text = 'ANTHROPIC_API_KEY=' + key;",
    "console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }));",
    "console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'BUGBOT_CLEAR' }] } }));",
    "console.log(JSON.stringify({ type: 'result', result: text + 'BUGBOT_CLEAR' }));",
  ].join("\n")
);
chmodSync(fakeBin, 0o755);

// callClaudeAgent/callCursorAgent spawn `claude`/`cursor` respectively. We can't swap
// the binary name, so this test drives spawnAgentStream indirectly by pointing the
// generic child at our fake via a shim on PATH is overkill; instead we test the env
// contract directly by re-exporting the child env behavior through callClaudeAgent's
// documented strip. We invoke via a tiny wrapper dir on PATH.
const shimDir = mkdtempSync(path.join(tmpdir(), "relay-core-shim-"));
for (const name of ["claude", "cursor"]) {
  const shim = path.join(shimDir, name);
  writeFileSync(shim, `#!/usr/bin/env node\nimport(${JSON.stringify(fakeBin)});\n`);
  chmodSync(shim, 0o755);
}
process.env.PATH = [shimDir, process.env.PATH].join(path.delimiter);

// A non-secret sentinel: we only need a distinctive marker to prove the child does or
// does not see this env var. Deliberately short (< 20 chars) and NOT a token so the
// secrets scanner's "Generic API Key" rule (api_key = "<20+ chars>") never flags it.
const PARENT_SENTINEL = "parent-set";
process.env.ANTHROPIC_API_KEY = PARENT_SENTINEL;

console.log("callClaudeAgent strips ANTHROPIC_API_KEY from the builder child");
{
  const out = await callClaudeAgent("do a thing", 30000, { extraArgs: [] });
  check("child reports the key UNSET", out.includes("ANTHROPIC_API_KEY=<unset>"));
}

console.log("callClaudeAgent strips even when the caller supplies its own env");
{
  const out = await callClaudeAgent("do a thing", 30000, {
    env: { ...process.env, GIT_CEILING_DIRECTORIES: "/tmp" },
  });
  check(
    "caller-supplied env still has the key stripped",
    out.includes("ANTHROPIC_API_KEY=<unset>")
  );
}

console.log("callCursorAgent (no env override) inherits the parent env");
{
  const out = await callCursorAgent("review", 30000, { extraArgs: [] });
  check("Cursor child still sees the key", out.includes("ANTHROPIC_API_KEY=" + PARENT_SENTINEL));
}

console.log("callCursorAgent can select Cursor's final assistant message");
{
  const out = await callCursorAgent("review", 30000, {
    extraArgs: [],
    preferLastAssistant: true,
  });
  check("progress narration is excluded from a verdict response", out === "BUGBOT_CLEAR");
}

rmSync(dir, { recursive: true, force: true });
rmSync(shimDir, { recursive: true, force: true });

// callDeepSeekDirect — pinned sampling is threaded into the request body only when provided, so the
// spec evaluator can run deterministically (temperature 0) without changing any other DeepSeek call.
console.log("callDeepSeekDirect threads temperature/top_p only when the caller pins them");
{
  const realFetch = globalThis.fetch;
  const realKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "test-key";
  const okResponse = () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ choices: [{ message: { content: "hi" } }] }),
  });
  try {
    let captured;
    globalThis.fetch = async (_url, init) => {
      captured = JSON.parse(init.body);
      return okResponse();
    };
    await callDeepSeekDirect("prompt", 30000, { temperature: 0, top_p: 1 });
    check("pinned call sends temperature 0", captured.temperature === 0);
    check("pinned call sends top_p 1", captured.top_p === 1);

    await callDeepSeekDirect("prompt", 30000, {});
    check("unpinned call omits temperature", !("temperature" in captured));
    check("unpinned call omits top_p", !("top_p" in captured));
  } finally {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = realKey;
  }
}

console.log(failed ? `${RED}${failed} check(s) failed${NC}` : `${GREEN}all checks passed${NC}`);
process.exit(failed ? 1 : 0);

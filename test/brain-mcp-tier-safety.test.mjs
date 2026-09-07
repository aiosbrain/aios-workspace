// Networked acceptance, launched by the pinned Brain test-support harness.
// Run through scripts/test-mcp-tier-safety.mjs; missing infrastructure is fatal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { once } from 'node:events';

const fixture = JSON.parse(process.env.MCP_SAFETY_FIXTURE || 'null');
const pending = new Map();
let controlId = 0;
process.on('message', (message) => {
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  clearTimeout(entry.timer);
  message.error ? entry.reject(new Error(message.error)) : entry.resolve(message.result);
});
function control(command) {
  return new Promise((resolve, reject) => {
    const id = ++controlId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`control timeout: ${command}`)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    process.send({ id, command });
  });
}

async function startMcp(key, t) {
  const cwd = await mkdtemp(join(tmpdir(), 'mcp-tier-'));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/brain-mcp.mjs', import.meta.url))], {
    cwd, env: { PATH: process.env.PATH, HOME: cwd, AIOS_BRAIN_URL: fixture.url,
      AIOS_API_KEY: key, AIOS_TEAM: fixture.team }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let id = 0;
  const calls = new Map();
  const lines = createInterface({ input: child.stdout });
  child.stderr.resume(); // Synthetic config only; stdout must remain pure JSON-RPC.
  lines.on('line', (line) => {
    try {
      const result = JSON.parse(line);
      const call = calls.get(result.id);
      if (call) { clearTimeout(call.timer); calls.delete(result.id); call.resolve(result); }
    } catch (error) { for (const call of calls.values()) call.reject(error); }
  });
  child.on('error', (error) => { for (const call of calls.values()) call.reject(error); });
  t.after(async () => {
    const closed = once(child, 'close');
    child.stdin.end();
    const kill = setTimeout(() => child.kill('SIGKILL'), 5000);
    try {
      if (child.exitCode === null && child.signalCode === null) await closed;
      assert.equal(child.exitCode, 0, 'MCP must exit cleanly');
    } finally {
      clearTimeout(kill);
      lines.close();
      for (const call of calls.values()) clearTimeout(call.timer);
      await rm(cwd, { recursive: true });
    }
    console.log('MCP_PROCESS_CLEANUP_OK');
  });
  return async (method, params = {}) => {
    const requestId = ++id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { calls.delete(requestId); reject(new Error(`MCP timeout: ${method}`)); }, 15000);
      calls.set(requestId, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
    });
  };
}

async function direct(path, key) {
  const response = await fetch(`${fixture.url}/api/v1${path}`, {
    headers: { Authorization: `Bearer ${key}`, 'X-AIOS-Team': fixture.team },
    signal: AbortSignal.timeout(15000),
  });
  return { status: response.status, body: await response.json() };
}
function data(response) {
  assert.equal(response.error, undefined);
  assert.equal(response.result.isError, undefined);
  return JSON.parse(response.result.content[0].text);
}
async function initialize(rpc) {
  const response = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'tier-safety', version: '1' } });
  assert.ok(response.result.serverInfo);
  return (await rpc('tools/list')).result.tools.map((tool) => tool.name);
}

test('live MCP authorization boundary', { timeout: 120000 }, async (t) => {
  assert.ok(fixture && process.send, 'Disposable Brain harness required; refusing an offline pass');
  try {
    await t.test('project-route denial survives a stale team tool list', async (t) => {
      const rpc = await startMcp(fixture.teamKey, t);
      assert.equal((await direct('/me', fixture.teamKey)).body.tier, 'team');
      assert.ok((await initialize(rpc)).includes('brain_list_projects'));
      const projects = data(await rpc('tools/call', { name: 'brain_list_projects', arguments: {} }));
      assert.ok(projects.projects.length > 0, 'team board fixture must be nonempty');
      await control('demote');
      assert.equal((await direct('/me', fixture.teamKey)).body.tier, 'external');
      assert.ok((await rpc('tools/list')).result.tools.some((tool) => tool.name === 'brain_list_projects'));
      const result = await rpc('tools/call', { name: 'brain_list_projects', arguments: {} });
      assert.equal(result.result.isError, true, 'MCP_PROJECT_DENIAL: Brain must deny the stale board tool');
      assert.match(result.result.content[0].text, /403.*forbidden_tier|403.*projects/i);
      assert.equal((await direct('/projects', fixture.teamKey)).status, 403);
    });
    await t.test('item visibility follows explicit grants and revocation', async (t) => {
      const rpc = await startMcp(fixture.externalKey, t);
      assert.ok((await initialize(rpc)).includes('brain_pull_items'));
      async function check(expected) {
        const result = data(await rpc('tools/call', { name: 'brain_pull_items', arguments: {} }));
        const paths = result.items.map((item) => item.path).sort();
        assert.deepEqual(paths, [...expected].sort(), 'MCP_ITEM_VISIBILITY: exact nonempty authorized fixture membership');
        const http = await direct('/items', fixture.externalKey);
        assert.equal(http.status, 200);
        assert.deepEqual(http.body.items.map((item) => item.path).sort(), paths);
        assert.equal(result.next_cursor, null);
      }
      await check([fixture.visible]);
      await control('grant');
      await check([fixture.visible, fixture.granted]);
      await control('revoke');
      await check([fixture.visible]);
    });
  } finally {
    process.disconnect();
  }
});

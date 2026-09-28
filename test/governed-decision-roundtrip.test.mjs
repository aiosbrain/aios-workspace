import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeDecisionWriteback } from '../scripts/pull-decisions.mjs';
import { parseDecisionRows, redactAdminDecisionRows } from '../scripts/workspace-parse.mjs';
const header = '| # | Date | Decision | Rationale | Decided By | Impact | Type | Audience |\n| --- | --- | --- | --- | --- | --- | --- | --- |';
const fixture = {
  row_key: 'ui-roundtrip', decided_at: '2026-09-28', title: '😀'.repeat(500),
  rationale: '😀'.repeat(25000), impact: '🌍'.repeat(5000), decided_by: 'authenticated-actor', tier: null, audience: 'team',
};
test('maximum accepted action content survives the existing pull-to-push representation', () => {
  const doc = mergeDecisionWriteback(header+'\n', [fixture]);
  const outbound = redactAdminDecisionRows(doc);
  assert.deepEqual(outbound.rows, [fixture]);
  assert.deepEqual(parseDecisionRows(outbound.body), [fixture]);
  assert.equal(mergeDecisionWriteback(doc, [fixture]), doc);
});
test('adjacent legacy tables are converted with their own original decoding mode', () => {
  const doc = header+'\n| old-one | | Literal &amp; | | A | | | team |\n'+header+'\n| old-two | | Literal &#10; | | B | | | team |\n';
  const merged = mergeDecisionWriteback(doc, [{ ...fixture, title: 'Choice', rationale: 'Why', impact: '' }]);
  const parsed = parseDecisionRows(merged);
  assert.equal(parsed.find(r => r.row_key === 'old-one').title, 'Literal &amp;');
  assert.equal(parsed.find(r => r.row_key === 'old-two').title, 'Literal &#10;');
  assert.equal(parsed.filter(r => r.row_key === fixture.row_key).length, 1);
});

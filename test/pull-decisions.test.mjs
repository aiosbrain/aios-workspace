import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeDecisionWriteback } from '../scripts/pull-decisions.mjs';
import { parseDecisionRows, redactAdminDecisionRows } from '../scripts/workspace-parse.mjs';
const header = '| # | Date | Decision | Rationale | Decided By | Impact | Type | Audience |\n| --- | --- | --- | --- | --- | --- | --- | --- |';
const row = (over = {}) => ({ row_key: 'ui-one', decided_at: '2026-09-28', title: 'Orbit', rationale: 'Because', decided_by: 'actor', impact: '', tier: null, audience: 'team', ...over });

test('accepted decision content survives pull, replay and parsing', () => {
  const content = '\ufeff# Decisions\n\n'+header+'\n';
  const incoming = row({ title: '\u00a0😀 | \\ $&\u2003', rationale: '\tfirst\r\nsecond &#10; &amp; <tag>\t', impact: ' '.repeat(2)+'$1' });
  const merged = mergeDecisionWriteback(content, [incoming]);
  assert.ok(merged.includes('<!-- aios:decision-cells:v1 -->'));
  assert.deepEqual(parseDecisionRows(merged)[0], incoming);
  assert.equal(mergeDecisionWriteback(merged, [incoming]), merged);
});
test('converts old table mode once without decoding literal entity-looking text', () => {
  const content = '# Decisions\n'+header+'\n| old | 2026-01-01 | Literal &#10; | &amp; | X | | | team |\n| secret | | Private | hidden | X | | | private |\n\n## Notes\nunchanged';
  const merged = mergeDecisionWriteback(content, [row()]);
  assert.equal(parseDecisionRows(merged).find(r => r.row_key === 'old').title, 'Literal &#10;');
  assert.ok(merged.includes('secret'));
  assert.ok(merged.endsWith('## Notes\nunchanged'));
  assert.equal(parseDecisionRows(merged).find(r => r.row_key === 'secret').audience, 'admin');
  assert.ok(!redactAdminDecisionRows(merged).body.includes('hidden'));
});
test('updates an existing row without interpreting replacement sequences or duplicating keys', () => {
  const content = header+'\n| ui-one | | Old | Old | X | | | team |\n';
  const merged = mergeDecisionWriteback(content, [row({ title: '$& $1 $$' })]);
  assert.equal(parseDecisionRows(merged)[0].title, '$& $1 $$');
  assert.equal(parseDecisionRows(merged).length, 1);
});
test('adds a decision table to a document without one and leaves unrelated prose intact', () => {
  const merged = mergeDecisionWriteback('# Log\n\nSome prose\n', [row()]);
  assert.ok(merged.startsWith('# Log\n\nSome prose\n'));
  assert.deepEqual(parseDecisionRows(merged), [row()]);
});
test('an empty feed makes no formatting changes', () => {
  assert.equal(mergeDecisionWriteback('# untouched\r\n', []), '# untouched\r\n');
});

test('a legacy table missing optional columns gains complete decision content', () => {
  const old = '| # | Decision | Audience |\n| --- | --- | --- |\n| ui-one | Old | team |\n';
  assert.deepEqual(parseDecisionRows(mergeDecisionWriteback(old, [row()])), [row()]);
});

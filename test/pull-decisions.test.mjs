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

test('pull never repairs malformed restricted rows into publishable rows', () => {
  for (const local of [
    '| local | | Secret | synthetic-private-sentinel | actor | | | team | private |',
    '| local | | Secret | synthetic-private-sentinel | actor | | |',
  ]) {
    const before = header+'\n'+local+'\n';
    assert.ok(!redactAdminDecisionRows(before).body.includes('synthetic-private-sentinel'));
    const after = mergeDecisionWriteback(before, [row()]);
    assert.ok(!redactAdminDecisionRows(after).body.includes('synthetic-private-sentinel'));
    assert.deepEqual(parseDecisionRows(after), [row()]);
  }
});
test('blank-separated local continuation uses the same encoding once', () => {
  const content = header+'\n| old | | Literal | &#124; &amp; | actor | | | team |\n\n| continuation | | Literal | &#124; &amp; | actor | | | team |\n';
  const result = mergeDecisionWriteback(content, [row()]);
  for (const key of ['old', 'continuation']) {
    assert.equal(parseDecisionRows(result).find(r => r.row_key === key).rationale, '&#124; &amp;');
  }
  assert.equal(mergeDecisionWriteback(result, [row()]), result);
});
test('adjacent unrelated tables retain every byte and column', () => {
  const other = '| Task | Status |\n| --- | --- |\n| literal &#124; | active |\n';
  const before = header+'\n| old | | Legacy | because | actor | | | team |\n'+other;
  const result = mergeDecisionWriteback(before, [row()]);
  assert.ok(result.endsWith(other));
});

test('parser-recognized rows without outer pipes retain legacy entity literals', () => {
  const original = '# | Date | Decision | Rationale | Decided By | Impact | Type | Audience\n--- | --- | --- | --- | --- | --- | --- | ---\nlocal | | Literal &#124; | Literal &amp; | actor | | | team\n';
  const before = parseDecisionRows(original)[0];
  const after = mergeDecisionWriteback(original, [row()]);
  assert.deepEqual(parseDecisionRows(after).find(r => r.row_key === 'local'), before);
  assert.equal(mergeDecisionWriteback(after, [row()]), after);
});

test('data followed by a separator keeps parser values and deny-only continuation', () => {
  const original = header+'\n| local | | Literal &#124; | &amp; | actor | | | team |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| hidden | | Denied continuation | private-sentinel | actor | | | team |\n';
  const before = parseDecisionRows(original);
  const after = mergeDecisionWriteback(original, [row()]);
  assert.deepEqual(parseDecisionRows(after).filter(r => r.row_key !== 'ui-one'), before);
  assert.ok(!redactAdminDecisionRows(after).body.includes('private-sentinel'));
  assert.equal(mergeDecisionWriteback(after, [row()]), after);
});

test('malformed same-key rows stay withheld beside one canonical mirror', () => {
  const original = '| # | Decision | Audience |\n| --- | --- | --- |\n| ui-one | private-sentinel | team | private |\n';
  const after = mergeDecisionWriteback(original, [row()]);
  assert.deepEqual(redactAdminDecisionRows(after).rows, [row()]);
  assert.ok(!redactAdminDecisionRows(after).body.includes('private-sentinel'));
  assert.ok(after.includes('private-sentinel'));
  assert.equal(mergeDecisionWriteback(after, [row()]), after);
});

test('missing row-key column retains its original implicit key and unknown columns', () => {
  const original = '| Decision | Audience | Local Detail |\n| --- | --- | --- |\n| Existing | team | local-detail |\n';
  const after = mergeDecisionWriteback(original, [row()]);
  assert.equal(parseDecisionRows(after).find(r => r.title === 'Existing').row_key, 'Existing');
  assert.ok(after.includes('local-detail'));
  assert.equal(mergeDecisionWriteback(after, [row()]), after);
});

test('duplicate removal preserves the original deny-only table transition', () => {
  const original = header+'\n| ui-one | | First | | actor | | | team |\n\n| ui-one | | Duplicate | | actor | | | team |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| orphan | | Hidden | withheld-sentinel | actor | | | team |\n';
  const merged = mergeDecisionWriteback(original, [row()]);
  assert.deepEqual(redactAdminDecisionRows(merged).rows, [row()]);
  assert.ok(!redactAdminDecisionRows(merged).body.includes('withheld-sentinel'));
  assert.ok(merged.includes('withheld-sentinel'));
  assert.equal(mergeDecisionWriteback(merged, [row()]), merged);
});

test('canonical text resembling header cells survives a separator-followed replacement', () => {
  const original = header+'\n| ui-one | | Old | Old | actor | | | team |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n';
  const incoming = row({ title: 'Decision', impact: '#' });
  const merged = mergeDecisionWriteback(original, [incoming]);
  assert.deepEqual(parseDecisionRows(merged), [incoming]);
  assert.equal(mergeDecisionWriteback(merged, [incoming]), merged);
});

test('unrelated pull preserves original parser outcomes across table boundaries and widths', () => {
  const headers = [['#', 'Decision', 'Audience'], ['#', 'Decision'], ['#', 'Decision', 'Audience', 'Local']];
  const data = [
    ['local', 'Literal &#124;', 'team'], ['secret', 'withheld-sentinel', 'private'],
    ['local', 'Short'], ['local', 'Long', 'team', 'private'], ['#', 'unknown', 'team'], ['local', 'Decision', 'team'],
  ];
  const gaps = ['', '\n', 'prose\n', '|---|---|---|\n'];
  const tails = ['', '\n|---|---|---|', '\n| Tail | Other |\n|---|---|\n| x | y |'];
  for (const columns of headers) for (const cells of data) for (const gap of gaps) for (const tail of tails) {
    const table = '| '+columns.join(' | ')+' |\n| '+columns.map(() => '---').join(' | ')+' |\n';
    const original = table+gap+'| '+cells.join(' | ')+' |'+tail+'\n';
    const before = redactAdminDecisionRows(original, 'team');
    const merged = mergeDecisionWriteback(original, [row()], 'team');
    const after = redactAdminDecisionRows(merged, 'team');
    assert.deepEqual(after.rows.filter(r => r.row_key !== 'ui-one'),
      before.rows.map(r => ({ ...r, audience: r.audience ?? 'team' })), original);
    if (!before.body.includes('withheld-sentinel')) assert.ok(!after.body.includes('withheld-sentinel'), original);
    assert.equal(mergeDecisionWriteback(merged, [row()], 'team'), merged, original);
  }
});

test('unknown header entities and escaped pipes are not re-encoded across pulls', () => {
  const original = '| # | Decision | Audience | Local &amp; detail \\| extra |\n| --- | --- | --- | --- |\n| local | Original | team | Literal &#124; |\n';
  const merged = mergeDecisionWriteback(original, [row()]);
  assert.ok(merged.includes('| Local &amp; detail \\| extra |'));
  assert.ok(merged.includes('Literal &amp;#124;'));
  assert.equal(mergeDecisionWriteback(merged, [row()]), merged);
});

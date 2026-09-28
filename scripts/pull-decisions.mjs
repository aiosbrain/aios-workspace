// Use the parser's original table classification so conversion and redaction agree.
import {
  encodeTableCell, decodeTableCell, DECISION_CELL_MARKER,
  classifyDecisionTableLines, parseFrontmatter, normalizeTier,
} from './workspace-parse.mjs';

const COLUMNS = {
  row_key: '#', decided_at: 'Date', title: 'Decision', rationale: 'Rationale',
  decided_by: 'Decided By', impact: 'Impact', tier: 'Type', audience: 'Audience',
};
const render = cells => '| '+cells.map(value => encodeTableCell(String(value ?? ''))).join(' | ')+' |';
const TABLE_END = '<!-- decision table boundary -->';
const separator = width => '| '+Array.from({ length: width }, () => '---').join(' | ')+' |';

/** Pure mirror merge. Full documents resolve missing Audience exactly as sync-plan does. */
export function mergeDecisionWriteback(content, rows, fallbackAudience) {
  if (!rows.length) return content;
  const { frontmatter, body } = parseFrontmatter(content);
  const prefix = content.slice(0, content.length - body.length);
  const inheritedAudience = normalizeTier(fallbackAudience ?? frontmatter?.access ?? '');
  const incoming = new Map(rows.map(row => [String(row.row_key), row]));
  const pending = new Map(incoming);
  const lines = body.split('\n');
  const classified = classifyDecisionTableLines(body, inheritedAudience);
  const tables = new Map();
  const replacements = new Map();
  for (const info of classified) {
    if (info.kind !== 'header' || !info.schema.isDecision || !info.schema.valid) continue;
    const header = [...info.cells];
    const columns = { ...info.schema.columns };
    const missing = Object.keys(COLUMNS).filter(key => columns[key] < 0);
    for (const key of missing) { columns[key] = header.length; header.push(COLUMNS[key]); }
    const table = { ...info.schema, header, columns, missing };
    tables.set(info.index, table);
    // The marker encodes DATA cells only. Preserve original header spelling/escapes;
    // encoding an unknown header would encode its entities again on every pull.
    const originalHeader = lines[info.index].trimEnd();
    const expandedHeader = missing.length
      ? originalHeader + (originalHeader.endsWith('|') ? ' ' : ' | ') + missing.map(key => COLUMNS[key]).join(' | ') + ' |'
      : lines[info.index];
    replacements.set(info.index, [
      ...(info.schema.encoded ? [] : [DECISION_CELL_MARKER]), expandedHeader,
    ]);
    if (classified[info.index + 1]?.kind === 'separator') {
      replacements.set(info.index + 1, [separator(header.length)]);
    }
  }
  for (const info of classified) {
    if (info.kind !== 'row') continue;
    const table = tables.get(info.schema.headerIndex);
    if (!table) continue;
    let cells = info.schema.encoded ? info.cells.map(decodeTableCell) : [...info.cells];
    const remote = info.row && incoming.get(info.row.row_key);
    if (remote) {
      if (!pending.has(info.row.row_key)) {
        replacements.set(info.index, info.endsTable ? [TABLE_END] : ['']);
        continue;
      }
      pending.delete(info.row.row_key);
      // Unknown columns remain local and untouched; recognized fields use canonical values.
      for (const key of Object.keys(COLUMNS)) cells[table.columns[key]] = remote[key] ?? '';
    } else {
      // Never repair original arity. New fields inherit the ORIGINAL parsed semantics only.
      // A present blank Audience stays admin; an absent column inherits the file's explicit tier.
      for (const key of table.missing) {
        cells.push(info.row ? (key === 'audience' ? inheritedAudience : info.row[key] ?? '') : '');
      }
    }
    // Preserve the parser's deny-only transition even if a duplicate disappears or
    // accepted text happens to resemble a separator-backed header.
    replacements.set(info.index, [render(cells), ...(info.endsTable ? [TABLE_END] : [])]);
  }
  const additions = [...pending.values()];
  const first = tables.values().next().value;
  let insertion = null;
  if (first && additions.length) {
    insertion = first.headerIndex + 1;
    // Separators/blank lines leave the parser in the same state. Insert after that
    // preamble so a new mirror cannot accidentally become data-before-separator.
    while (insertion < lines.length &&
      (classified[insertion].kind === 'separator' || !lines[insertion].trim())) insertion++;
  }
  const renderRow = (row, table) => {
    const cells = table.header.map(() => '');
    for (const key of Object.keys(COLUMNS)) cells[table.columns[key]] = row[key] ?? '';
    return render(cells);
  };
  const output = [];
  for (let index = 0; index < lines.length; index++) {
    if (index === insertion) output.push(...additions.map(row => renderRow(row, first)));
    output.push(...(replacements.get(index) ?? [lines[index]]));
  }
  if (insertion === lines.length) output.push(...additions.map(row => renderRow(row, first)));
  if (!first && additions.length) {
    if (output.at(-1) !== '') output.push('');
    const header = Object.values(COLUMNS);
    output.push(DECISION_CELL_MARKER, render(header), separator(header.length),
      ...additions.map(row => render(Object.keys(COLUMNS).map(key => row[key] ?? ''))), '');
  }
  return prefix + output.join('\n');
}

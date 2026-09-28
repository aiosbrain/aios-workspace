// Decision writeback is a read-only mirror. Convert complete tables to the marked
// cell format before mixing legacy values with accepted action text.
import { encodeTableCell, decodeTableCell, DECISION_CELL_MARKER } from './workspace-parse.mjs';
import { parseTableRows } from './tasks-table.mjs';

const MARKER = DECISION_CELL_MARKER;
const COLUMNS = ['#', 'date', 'decision', 'rationale', 'decided by', 'impact', 'type', 'audience'];
const HEADER = '| # | Date | Decision | Rationale | Decided By | Impact | Type | Audience |';
const SEPARATOR = '| --- | --- | --- | --- | --- | --- | --- | --- |';
const render = cells => '| '+cells.map(value => encodeTableCell(String(value ?? ''))).join(' | ')+' |';
const values = row => [row.row_key, row.decided_at ?? '', row.title, row.rationale ?? '', row.decided_by ?? '', row.impact ?? '', row.tier ?? '', row.audience ?? ''];
const tableLine = line => line.trim().startsWith('|');
const separator = line => /^\s*\|?[\s:|-]+\|\s*$/.test(line) && line.includes('-');

/** Returns a document with exactly one mirror per incoming row key; performs no I/O. */
export function mergeDecisionWriteback(content, rows) {
  if (!rows.length) return content;
  const incoming = new Map(rows.map(row => [String(row.row_key), row]));
  const pending = new Map(incoming);
  const lines = content.split('\n');
  const output = [];
  let firstTableInsert = null;
  for (let index = 0; index < lines.length; index++) {
    const header = parseTableRows(lines[index])[0];
    const normalized = header?.map(cell => cell.trim().toLowerCase());
    if (!header || !normalized.includes('decision') || !normalized.includes('#') || !separator(lines[index + 1] ?? '')) {
      output.push(lines[index]);
      continue;
    }
    const marked = output.at(-1)?.trim() === MARKER;
    if (marked) output.pop();
    const originalWidth = header.length;
    const missing = COLUMNS.filter(column => !normalized.includes(column));
    header.push(...missing);
    normalized.push(...missing);
    output.push(MARKER, missing.length ? render(header) : lines[index],
      missing.length ? '| '+header.map(() => '---').join(' | ')+' |' : lines[index + 1]);
    index++;
    while (index + 1 < lines.length && (tableLine(lines[index + 1]) || !lines[index + 1].trim())) {
      if (!lines[index + 1].trim()) { output.push(lines[++index]); continue; }
      const nextHeader = parseTableRows(lines[index + 1])[0]?.map(cell => cell.toLowerCase());
      if (nextHeader && separator(lines[index + 2] ?? '')) break;
      const originalLine = lines[++index];
      if (separator(originalLine)) { output.push(originalLine); continue; }
      let cells = parseTableRows(originalLine)[0];
      if (!cells) { output.push(originalLine); continue; }
      if (marked) cells = cells.map(decodeTableCell);
      // Preserve malformed width: repairing it can turn a withheld private row into public data.
      if (cells.length !== originalWidth) {
        output.push(render([...cells, ...missing.map(() => '')]));
        continue;
      }
      const key = cells[normalized.indexOf('#')];
      const incomingRow = incoming.get(key);
      if (incomingRow) {
        // If a legacy document duplicates a key across tables, retain only one mirror.
        if (!pending.has(key)) continue;
        const canonical = values(incomingRow);
        cells = header.map((_, column) => {
          const known = COLUMNS.indexOf(normalized[column]);
          return known < 0 ? cells[column] ?? '' : canonical[known];
        });
        pending.delete(key);
      }
      output.push(render(header.map((_, column) => cells[column] ?? '')));
    }
    if (firstTableInsert === null) firstTableInsert = { at: output.length, header, normalized };
  }
  if (pending.size) {
    if (firstTableInsert) {
      const { at, header, normalized } = firstTableInsert;
      output.splice(at, 0, ...[...pending.values()].map(row => {
        const canonical = values(row);
        return render(header.map((_, index) => {
          const column = COLUMNS.indexOf(normalized[index]);
          return column < 0 ? '' : canonical[column];
        }));
      }));
    } else {
      if (output.at(-1) !== '') output.push('');
      output.push(MARKER, HEADER, SEPARATOR, ...[...pending.values()].map(row => render(values(row))), '');
    }
  }
  return output.join('\n');
}

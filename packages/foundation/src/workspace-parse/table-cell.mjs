/** Marker-scoped encoding: historical tables never interpret entity-looking user text. */
export const DECISION_CELL_MARKER = "<!-- aios:decision-cells:v1 -->";
const encoded = { "&": "&amp;", "|": "&#124;", "\n": "&#10;", "\r": "&#13;", "<": "&lt;", ">": "&gt;", "\\": "&#92;" };
const decoded = { amp: "&", lt: "<", gt: ">" };
export function encodeTableCell(value) {
  const text = String(value ?? "");
  const start = text.match(/^\s*/u)[0].length;
  const end = text.length - text.match(/\s*$/u)[0].length;
  let offset = 0;
  let result = "";
  for (const char of text) {
    result += encoded[char] ?? ((offset < start || offset >= end) && /\s/u.test(char)
      ? `&#${char.codePointAt(0)};` : char);
    offset += char.length;
  }
  return result;
}
export function decodeTableCell(value) {
  return String(value).replace(/&(amp|lt|gt|#\d+);/g, (match, name) => {
    if (decoded[name]) return decoded[name];
    const point = Number(name.slice(1));
    if (![9, 10, 13, 32, 92, 124].includes(point) &&
        !(point <= 0x10ffff && /\s/u.test(String.fromCodePoint(point)))) return match;
    return String.fromCodePoint(point);
  });
}

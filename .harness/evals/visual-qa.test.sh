#!/usr/bin/env bash
# Deterministic regressions for skills/visual-qa/scripts/visual-qa.mjs:
#   - importing the module must not execute main() (ESM direct-run detection)
#   - direct run works end-to-end on generated PNGs
#   - interlaced (Adam7) PNGs are rejected explicitly instead of decoding garbage
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0
FAIL=0
TMP=$(mktemp -d /tmp/harness-visual-qa.XXXXXX)
trap 'rm -rf "$TMP"' EXIT

report() {
  local name="$1" status="$2"
  if [ "$status" -eq 0 ]; then
    PASS=$((PASS+1)); echo "PASS: $name"
  else
    FAIL=$((FAIL+1)); echo "FAIL: $name"
  fi
}

# This is a deterministic floor: a missing interpreter is a failure, not a skip.
command -v node >/dev/null 2>&1 || { echo "FAIL: node is required for visual-qa.test.sh"; exit 1; }

SCRIPT="$ROOT/skills/visual-qa/scripts/visual-qa.mjs"

# Minimal valid PNG writer (8-bit RGBA, filter 0) with an interlace switch.
cat > "$TMP/make-png.mjs" <<'EOF'
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const [, , out, colorHex, interlaceArg] = process.argv;
const interlace = interlaceArg === "1" ? 1 : 0;
const [r, g, b] = [0, 2, 4].map((i) => parseInt(colorHex.slice(i, i + 2), 16));
const width = 4, height = 4;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(width, 0);
ihdr.writeUInt32BE(height, 4);
ihdr[8] = 8;          // bit depth
ihdr[9] = 6;          // color type RGBA
ihdr[12] = interlace; // 0 = none, 1 = Adam7

const raw = Buffer.alloc(height * (1 + width * 4));
for (let y = 0; y < height; y++) {
  const row = y * (1 + width * 4);
  for (let x = 0; x < width; x++) {
    raw.set([r, g, b, 255], row + 1 + x * 4);
  }
}

writeFileSync(out, Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw)),
  chunk("IEND", Buffer.alloc(0)),
]));
EOF

# Fail closed if any fixture cannot be generated.
for spec in "ref.png ff0000 0" "act.png ff0000 0" "other.png 00ff00 0" "interlaced.png ff0000 1"; do
  set -- $spec
  if ! node "$TMP/make-png.mjs" "$TMP/$1" "$2" "$3" || [ ! -s "$TMP/$1" ]; then
    echo "FAIL: could not generate fixture $1"
    exit 1
  fi
done

# JSON-parse helper: read a numeric field from the CLI's stdout (formatting-independent).
json_field() {  # json_field <json> <field>
  printf '%s' "$1" | node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const data = JSON.parse(readFileSync(0, "utf8"));
    const value = data[process.argv[1]];
    if (typeof value !== "number") { process.exit(1); }
    console.log(value);
  ' "$2"
}

# 1. Importing the module must not run main() (no stdout, exit 0).
IMPORT_OUT=$(node --input-type=module -e "await import('file://$SCRIPT'); " 2>&1)
[ $? -eq 0 ] && [ -z "$IMPORT_OUT" ]
report "import does not execute main()" $?

# 2. Direct run still works: identical images diff to zero.
DIRECT_OUT=$(node "$SCRIPT" image-diff "$TMP/ref.png" "$TMP/act.png" 2>&1) &&
  [ "$(json_field "$DIRECT_OUT" diffPixels)" = "0" ]
report "direct run diffs identical images to zero" $?

# 3. Direct run detects a real difference (nonzero pixel count).
DIFF_OUT=$(node "$SCRIPT" image-diff "$TMP/ref.png" "$TMP/other.png" 2>&1) &&
  DIFF_PIXELS="$(json_field "$DIFF_OUT" diffPixels)" &&
  [ -n "$DIFF_PIXELS" ] && [ "$DIFF_PIXELS" -gt 0 ]
report "direct run reports a nonzero diff for different images" $?

# 4. Interlaced PNG is rejected with an explicit error, not garbled metrics.
INTERLACED_OUT=$(node "$SCRIPT" image-diff "$TMP/interlaced.png" "$TMP/act.png" 2>&1)
[ $? -ne 0 ] && printf '%s' "$INTERLACED_OUT" | grep -q "unsupported interlaced PNG"
report "interlaced PNG is rejected explicitly" $?

echo "visual-qa.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ] || exit 1

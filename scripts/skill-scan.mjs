#!/usr/bin/env node
/**
 * skill-scan.mjs — pure, reusable static safety scanner for an Agent Skill directory.
 *
 * Phase 3.5 (untrusted-install). #17 shipped a TRUSTED official library where safety
 * rests on provenance + integrity. This phase admits skills beyond that vendored set,
 * so before a non-official skill is installed we statically scan it and surface what we
 * found. The scan is ADVISORY ONLY — scanners get bypassed (arxiv 2510.26328, Snyk
 * ToxicSkills, VentureBeat); provenance + human review carry the real trust. Its job is
 * to give a reviewer the flagged file:line so consent is informed, NOT to certify safety.
 *
 * scanSkill(dir) walks SKILL.md + every bundled file and flags:
 *   • bundled code            (.py/.mjs/.js/.sh/… — Claude may execute these as tools)
 *   • network egress          (fetch/http/https/curl/wget/requests/urllib/sockets)
 *   • filesystem/process exec (child_process/exec/spawn/subprocess/os.system/eval/fs writes+deletes)
 *   • secret / exfil reads    (.env / .env.keys / AWS_ creds / process.env dumps / base64-then-network)
 *   • external URLs in SKILL.md
 *   • prompt-injection         (zero-width / bidi / hidden Unicode; "ignore previous
 *                               instructions"/role-override phrasing)
 *
 * Returns { riskClass: "low"|"elevated"|"high", findings: [{file, line, rule, snippet}], counts }.
 * Classification:
 *   high     — any network / secret / external-URL / injection / hidden-unicode finding
 *   elevated — bundles code (but none of the high signals)
 *   low      — instructions only, no code, no high signals
 *
 * Pure: no writes, no network, no process spawning. Safe to call on untrusted input.
 *
 * Usage (CLI):  node scripts/skill-scan.mjs <skill-dir> [--json]
 */

import {
  readFileSync,
  readdirSync,
  lstatSync,
  existsSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import path from "node:path";

const CODE_RE = /\.(py|mjs|cjs|js|jsx|ts|tsx|sh|bash|zsh|rb|go|pl|php|ps1)$/i;
// Files we read as text to scan line-by-line. Anything else (images, archives) is only
// noted for its extension (a bundled .tar.gz is disclosed as code-adjacent, not scanned).
const TEXT_RE =
  /\.(md|txt|py|mjs|cjs|js|jsx|ts|tsx|sh|bash|zsh|rb|go|pl|php|ps1|json|ya?ml|toml|cfg|ini|html?|xml|env)$/i;
const MAX_BYTES = 2 * 1024 * 1024; // skip absurdly large text files

// ── zero-width / bidi / hidden Unicode (a classic SKILL.md prompt-injection vector) ──
// U+00AD soft hyphen; U+200B-200F zero-width + RLM/LRM; U+202A-202E bidi overrides;
// U+2060-2064 word-joiners; U+2066-2069 isolates; U+FEFF BOM/ZWNBSP.
const HIDDEN_CLASS = "\\u00AD\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF";
const HIDDEN_UNICODE_RE = new RegExp(`[${HIDDEN_CLASS}]`);
const HIDDEN_UNICODE_RE_G = new RegExp(`[${HIDDEN_CLASS}]`, "g");

function codePoint(ch) {
  return "U+" + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0");
}

// Each rule: { rule, severity: "high"|"info", re, where: "code"|"text"|"skillmd"|"any" }.
// "high" escalates riskClass to "high"; "info" is disclosed but does not escalate.
const RULES = [
  // — network egress —
  {
    rule: "network-egress",
    severity: "high",
    where: "code",
    re: /\b(fetch|XMLHttpRequest|axios|node-fetch|urllib|urllib2|urllib3|httpx|http\.client|WebSocket)\b|\brequests\.(get|post|put|delete|request|Session)\b|\bsocket\.(socket|connect|create_connection)\b|\bnet\.(connect|createConnection)\b|require\(['"]https?['"]\)|\bimport\s+https?\b/,
  },
  {
    rule: "network-egress-shell",
    severity: "high",
    where: "any",
    re: /\b(curl|wget|netcat)\b\s+\S|\bnc\b\s+-|\b(scp|ftp|telnet)\b\s+\S/,
  },
  // — filesystem / process execution —
  {
    rule: "process-exec",
    severity: "info",
    where: "code",
    re: /\b(child_process|execSync|execFileSync|spawnSync|spawn|execFile|subprocess|Popen|shell_exec|proc_open)\b|\bos\.(system|popen)\b|\bcommands\.getoutput\b|\bRuntime\.getRuntime\b/,
  },
  {
    rule: "dynamic-eval",
    severity: "info",
    where: "code",
    re: /\beval\s*\(|\bexec\s*\(|\bFunction\s*\(|\b__import__\b|\bimportlib\.import_module\b|\bvm\.runIn/,
  },
  {
    rule: "fs-write-delete",
    severity: "info",
    where: "code",
    re: /\b(writeFileSync|writeFile|rmSync|unlinkSync|unlink|appendFileSync)\b|\bos\.(remove|unlink)\b|\bshutil\.rmtree\b|\brm\s+-rf\b/,
  },
  // — secret / exfil reads —
  {
    rule: "secret-read",
    severity: "high",
    where: "any",
    re: /\.env(\.keys|\.local|\.production)?\b|\bprocess\.env\b|\bos\.environ\b|\bAWS_(ACCESS|SECRET)\w*|\bGITHUB_TOKEN\b|\bANTHROPIC_API_KEY\b|\bid_rsa\b|\.ssh\/|\bnetrc\b/,
  },
  {
    rule: "exfil-encode",
    severity: "info",
    where: "code",
    re: /\b(btoa|atob|b64encode|b64decode|hexlify)\b|\bbase64\b|toString\(['"]base64['"]\)/,
  },
];

// — prompt-injection phrasing (case-insensitive; SKILL.md + any text the model reads) —
const INJECTION_PHRASES = [
  /ignore\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above|preceding|earlier)\s+(?:instructions|prompts?|context|rules?)/i,
  /disregard\s+(?:all\s+)?(?:previous|prior|the\s+above|your)\s+(?:instructions|rules?|guidelines)/i,
  /forget\s+(?:everything|all\s+(?:previous|prior))/i,
  /you\s+are\s+now\b.{0,40}\b(?:mode|developer|dan|jailbreak|unrestricted)/i,
  /(?:new|updated|real|true)\s+(?:system\s+)?(?:instructions?|prompt|directive)s?\s*[:=]/i,
  /(?:do\s+not|don'?t)\s+(?:tell|inform|alert|mention\s+to)\s+the\s+user/i,
  /override\s+(?:your\s+)?(?:system\s+prompt|previous\s+instructions|safety)/i,
];

const URL_RE = /\bhttps?:\/\/[^\s)\]"'<>]+/gi;
// Reputable docs links in SKILL.md are common and benign; only flag NON-allowlisted hosts.
const URL_ALLOW =
  /^https?:\/\/([a-z0-9-]+\.)*(anthropic\.com|claude\.com|github\.com|githubusercontent\.com|npmjs\.com|python\.org|pypi\.org|modelcontextprotocol\.io|w3\.org|apache\.org|mozilla\.org)(\/|$|:)/i;

function snippet(line) {
  const s = line.replace(HIDDEN_UNICODE_RE_G, "·").trim();
  return s.length > 160 ? s.slice(0, 157) + "…" : s;
}

function walk(root, rel = "") {
  const out = [];
  for (const name of readdirSync(path.join(root, rel)).sort()) {
    const relChild = rel ? `${rel}/${name}` : name;
    const st = lstatSync(path.join(root, relChild));
    if (st.isSymbolicLink()) {
      out.push({ rel: relChild, symlink: true, size: 0 });
      continue;
    }
    if (st.isDirectory()) out.push(...walk(root, relChild));
    else if (st.isFile())
      out.push({ rel: relChild, symlink: false, size: st.size, exec: (st.mode & 0o111) !== 0 });
  }
  return out;
}

// Peek a file's first bytes to classify what an extension didn't: a leading "#!" is an
// executable script (must be scanned as code); a NUL byte means binary (don't scan as text).
function peek(abs) {
  let fd;
  try {
    fd = openSync(abs, "r");
    const buf = Buffer.alloc(512);
    const n = readSync(fd, buf, 0, 512, 0);
    const head = buf.subarray(0, n);
    return { binary: head.includes(0), shebang: n >= 2 && head[0] === 0x23 && head[1] === 0x21 };
  } catch {
    return { binary: false, shebang: false };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

function scanText(file, text, findings, { isSkillMd, isCode }) {
  const lines = text.split(/\r?\n/);
  const where = isSkillMd ? "skillmd" : isCode ? "code" : "text";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ln = i + 1;

    // Hidden Unicode — high signal anywhere it appears.
    const hidden = line.match(HIDDEN_UNICODE_RE);
    if (hidden) {
      findings.push({
        file,
        line: ln,
        rule: "hidden-unicode",
        severity: "high",
        snippet: `${codePoint(hidden[0])} hidden char — ${snippet(line)}`,
      });
    }

    // Prompt-injection phrasing.
    for (const re of INJECTION_PHRASES) {
      if (re.test(line)) {
        findings.push({
          file,
          line: ln,
          rule: "prompt-injection",
          severity: "high",
          snippet: snippet(line),
        });
        break;
      }
    }

    // Rule table — code rules only on code files; "any" everywhere.
    for (const r of RULES) {
      if (r.where === "code" && where !== "code") continue;
      if (r.where === "text" && where === "code") continue;
      if (r.re.test(line))
        findings.push({
          file,
          line: ln,
          rule: r.rule,
          severity: r.severity,
          snippet: snippet(line),
        });
    }

    // External URLs in SKILL.md (non-allowlisted host) — high (a fetch target the user can't see).
    if (isSkillMd) {
      const urls = line.match(URL_RE);
      if (urls)
        for (const raw of urls) {
          const u = raw.replace(/[.,;:!?]+$/, ""); // drop trailing sentence punctuation
          if (!URL_ALLOW.test(u))
            findings.push({
              file,
              line: ln,
              rule: "external-url",
              severity: "high",
              snippet: u.length > 120 ? u.slice(0, 117) + "…" : u,
            });
        }
    }
  }
}

/**
 * scanSkill(dir) → { riskClass, findings, counts, bundlesCode, codeFiles }. Pure.
 * @param {string} dir path to a skill directory (must contain SKILL.md).
 */
export function scanSkill(dir) {
  if (!existsSync(dir)) throw new Error(`skill dir not found: ${dir}`);
  if (!existsSync(path.join(dir, "SKILL.md"))) throw new Error(`not a skill (no SKILL.md): ${dir}`);

  const findings = [];
  const entries = walk(dir);
  let bundlesCode = false;
  const codeFiles = [];

  for (const e of entries) {
    if (e.symlink) {
      findings.push({
        file: e.rel,
        line: 0,
        rule: "symlink",
        severity: "high",
        snippet: "symlink in skill tree (may escape the dir)",
      });
      continue;
    }
    const abs = path.join(dir, e.rel);
    const byExt = CODE_RE.test(e.rel) || TEXT_RE.test(e.rel);

    // Files no extension classified (e.g. an extensionless `scripts/helper`): peek the
    // bytes so a shebang/executable script can't slip through scanning as "not code".
    let shebang = false,
      binary = false;
    if (!byExt) {
      const p = peek(abs);
      shebang = p.shebang;
      binary = p.binary;
    }

    // A code extension, a shebang, or the executable bit (on a non-binary file) ⇒ code.
    const isCode = CODE_RE.test(e.rel) || shebang || (e.exec && !binary);
    if (isCode) {
      bundlesCode = true;
      codeFiles.push(e.rel);
    }

    // Non-text blobs (archives/binaries) are disclosed but not scanned.
    if (
      binary ||
      (!byExt && !isCode && /\.(gz|tgz|zip|tar|bin|so|dylib|dll|exe|wasm)$/i.test(e.rel))
    ) {
      findings.push({
        file: e.rel,
        line: 0,
        rule: "opaque-binary",
        severity: "info",
        snippet: "bundled non-text file — contents not scannable",
      });
      continue;
    }
    if (e.size > MAX_BYTES) {
      findings.push({
        file: e.rel,
        line: 0,
        rule: "oversize-file",
        severity: "info",
        snippet: `file > ${Math.round(MAX_BYTES / 1024)}KB — not scanned`,
      });
      continue;
    }

    // Scan content for: text/code-by-extension, exec/shebang scripts, AND any other
    // small text-like file (so an extensionless config carrying a URL/secret is caught).
    let text;
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    scanText(e.rel, text, findings, { isSkillMd: e.rel === "SKILL.md", isCode });
  }

  // Stable order: by file, then line, then rule.
  findings.sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule)
  );

  const hasHigh = findings.some((f) => f.severity === "high");
  const riskClass = hasHigh ? "high" : bundlesCode ? "elevated" : "low";
  const counts = {
    total: findings.length,
    high: findings.filter((f) => f.severity === "high").length,
    code_files: codeFiles.length,
  };
  return { riskClass, findings, counts, bundlesCode, codeFiles };
}

function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const dir = args.find((a) => !a.startsWith("--"));
  if (!dir) {
    console.error("usage: node scripts/skill-scan.mjs <skill-dir> [--json]");
    process.exit(2);
  }
  const res = scanSkill(dir);
  if (json) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }
  console.log(
    `risk: ${res.riskClass}  (${res.counts.high} high-severity of ${res.counts.total} findings; ${res.counts.code_files} code files)`
  );
  for (const f of res.findings)
    console.log(`  [${f.severity}] ${f.file}:${f.line}  ${f.rule}  — ${f.snippet}`);
  // Exit non-zero on high so it's CI-usable; advisory, so callers may ignore.
  process.exit(res.riskClass === "high" ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) main();

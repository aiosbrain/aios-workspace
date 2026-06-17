# Changelog

All notable changes to the AIOS Workspace are documented here. The format is
loosely based on [Keep a Changelog](https://keepachangelog.com/); dates are
ISO-8601.

This is the **individual workspace** repo. The Team Brain sync contract
(`docs/brain-api.md`) is versioned separately and is **unchanged** by the
entries below — no sync-protocol change, still `v1`.

## [0.3.0] — 2026-06-17

The cockpit overhaul: the local GUI (`npm run gui`) becomes a real workspace
cockpit — model choice, resumable chats, personality, an official-skills library,
and a draft-from-a-link onboarding path. No change to the spine, validators,
guard, harnesses, or the Team Brain sync contract.

### Added

#### Cockpit chat (#16)
- **Model picker** — switch between **Sonnet 4.6** (default; fast and cheap) and
  **Opus 4.8** from the chat header, **mid-session and with no reconnect**. The
  choice persists to `agent_model` in `aios.yaml`; an unknown value degrades to
  Sonnet with a visible warning.
- **Resumable chat history** — a Chats sidebar lists every saved conversation
  (titled from its first message, newest first). Reopen one to replay its
  transcript and resume the same session; `+ New chat` starts fresh; the
  last-open chat is restored on reload.
- **Context (est.) meter** — an approximate `~Nk / 200k` indicator of how much of
  the model's window the last turn used (input + cached tokens).
- **Markdown rendering** — assistant replies render as GitHub-flavored markdown;
  links open in a new tab without leaking the cockpit token.
- **Personality presets** (Settings → Personality) — **AIOS**, **Analyst**,
  **Coach**, **Operator**. A style layer over the system prompt only; it never
  overrides workspace rules, `CLAUDE.md`, or skills. Selecting one starts a new
  chat so the voice takes effect.

#### Skills library (#17)
- **One-click install of official Anthropic skills**, vendored from
  `anthropics/skills` and **hash-locked** to a pinned upstream commit, all
  **Apache-2.0**. Install copies the skill into `.claude/skills/` behind an
  integrity check, a collision guard, and an append-only install ledger;
  uninstall is safe-only and refuses to remove a skill with local edits. Vendored
  set: **skill-creator**, **mcp-builder**, **web-artifacts-builder**,
  **claude-api**, **frontend-design**.
- **Document skills are pointers, not copies** — Word (`docx`), Excel (`xlsx`),
  PowerPoint (`pptx`), PDF (`pdf`) are proprietary and Anthropic-hosted, surfaced
  as *Documents — available in Claude* with an **Enable in Claude ↗** link.

#### Onboarding enrichment (#20)
- **Draft your profile from a link** — first-run onboarding can take a single
  company/profile URL, read it with the `firecrawl-direct` skill (via Firecrawl),
  extract structured facts, and **draft** `.claude/CLAUDE.md` for you to **confirm
  before it's written**. Scraped content is treated as untrusted facts to confirm,
  never as instructions; only the one URL you supply is read (no crawling).

#### Skills — community installs, scanned (#22)
- **Install skills beyond the official library, with eyes open.** A new `community`
  trust tier runs a static safety scanner (`scripts/skill-scan.mjs`) over a skill's
  `SKILL.md` and **every bundled file** before install — flagging bundled code
  (including **extensionless shebang/executable scripts**), network egress,
  filesystem/process exec, secret/exfil reads, external URLs, and prompt-injection
  (incl. hidden/zero-width Unicode), with each finding shown as `file:line`. Install
  requires consent; a **high** risk class requires a typed confirm. Scanning is
  **advisory** — provenance + human review remain the trust anchor — and **official
  skills stay one-click**. The collision guard, install ledger, and safe-only
  uninstall from #17 carry over unchanged.

### Unchanged
- **`docs/brain-api.md` (sync contract) — `v1`, untouched.** None of #16/#17/#20/#22
  altered the Team Brain sync protocol, so there is no version bump and no
  workspace↔brain contract drift.

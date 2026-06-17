# Release notes — the cockpit overhaul

> Draft release notes for the next AIOS Workspace tag. Covers the cockpit work
> shipped in **#16**, **#17**, and **#20**. Grouped for a human-readable
> announcement; the machine-readable list is in [`CHANGELOG.md`](../../CHANGELOG.md).
>
> **Sync contract unchanged.** `docs/brain-api.md` stays at **v1** — none of this
> work touched the Team Brain sync protocol, so there is no version bump or
> contract drift.

## Headline

The local GUI (`npm run gui`) grows from a chat box into a real **workspace
cockpit**: pick your model, keep a history of resumable chats, choose the agent's
personality, install official skills with one click, and start onboarding by
pasting a link.

## What's new

### A real chat surface (#16)

- **Pick your model, switch anytime.** Choose **Sonnet 4.6** (the new default —
  fast and cheap) or **Opus 4.8** right in the chat header, and switch
  **mid-session with no reconnect**. Your choice is remembered in `aios.yaml`.
- **Chats that persist.** Conversations are saved to a sidebar and titled from
  their first message. Reopen one to pick up exactly where you left off; start a
  new one any time. The cockpit reopens your last chat on reload.
- **See how full the context is.** A *context (est.)* meter shows roughly how much
  of the model's window your last turn used.
- **Readable replies.** Assistant messages render as markdown — tables, lists,
  and code, not raw text.
- **Give the agent a voice.** In **Settings → Personality**, pick **AIOS**
  (calm, structured, the default), **Analyst** (rigorous, cited), **Coach**
  (warm, asks sharp questions), or **Operator** (terse, action-first). It's a
  style layer only — it never overrides your rules, `CLAUDE.md`, or skills.

### A skills library (#17)

- **Install official Anthropic skills in one click.** The **Skills** tab offers a
  curated, **Apache-2.0** set vendored straight from `anthropics/skills` and
  pinned to a locked commit: **skill-creator**, **mcp-builder**,
  **web-artifacts-builder**, **claude-api**, and **frontend-design**. Installing
  copies the skill into `.claude/skills/` behind an integrity check and an
  append-only ledger; removal is safe-only and won't clobber local edits.
- **Document skills point to Claude.** Word, Excel, PowerPoint, and PDF skills are
  Anthropic-hosted and proprietary, so they're shown as pointers — *Enable in
  Claude ↗* — rather than copied into your repo.

### Onboarding from a link (#20)

- **Draft your profile from a link.** On first run, paste one or a few company/profile
  links and the agent reads them (via Firecrawl) and **drafts** your workspace memory
  (`.claude/memory/USER.md` + `WORKSPACE.md`, plus canonical company/role facts in
  `0-context/`) — which you confirm before anything is written. Scraped content is
  treated as facts to confirm, never as instructions, and only the URLs you give are
  read. Connect Firecrawl in **Integrations** first.

## Upgrade notes

- **Default model is now Sonnet 4.6** in the cockpit's `claude-code` adapter
  (resolved from an empty/unknown `agent_model`). Switch to Opus 4.8 any time from
  the header; the choice persists.
- **No migration required.** The spine, validators, guard hook, harnesses, and the
  `aios` sync client are unchanged. Existing workspaces keep working as-is.
- **Firecrawl is optional** and only used if you choose the draft-from-a-link path.

# Getting started — zero to your first push

A linear, copy-pasteable path from the current stable release to **your first `aios push` landing
on the team's Team Brain**, then on to contributing to the platform itself.

Written for a new team member. Our team slug is **`aios`**. Where a step needs a
person to act on the brain side, that person is **John** (the brain admin).

---

## 1. Where things live (read this first)

Start from the immutable public release used for onboarding. Resolve the newest
release tag rather than typing a version — a number written into a doc goes stale
on the next release, and a stale one points new installs at a superseded build:

```bash
REPO=https://github.com/aiosbrain/aios-workspace.git
LATEST=$(git ls-remote --tags --refs --sort=-v:refname "$REPO" 'v*' \
  | head -1 | sed 's#.*refs/tags/##')
echo "$LATEST"   # sanity-check what you are about to clone

git clone --branch "$LATEST" --depth 1 "$REPO" aios-toolkit
cd aios-toolkit
```

Do not drop the `--branch "$LATEST"` for a normal install. A plain clone checks out
the moving `main` branch, which is the pre-release development surface for
contributors. Merging to `main` does not make a change part of the supported
install; publishing a release tag does.

There are **two separate folders** in this story, and mixing them up is the #1 way
people get stuck. Neither is optional — you need both, but you only ever *work* in
the second one.

**Folder A — the tagged toolkit you just cloned (`aios-toolkit`).** This is a shared
program, not your personal space. You run one command from here, and never touch
most of it again day-to-day.

```
aios-toolkit/                   ← you are here after the stable clone + `cd`
├── scripts/
│   ├── scaffold-project.sh     ← the ONE command that builds your real workspace (§5)
│   └── aios.mjs                ← the `aios` CLI (status/push/pull/query), run via `npm run aios`
├── scaffold/                   ← TEMPLATES ONLY — nothing here is a real file yet.
│   │                             See scaffold/README.md if you're curious; you
│   │                             shouldn't need to open this folder otherwise.
│   ├── aios.yaml.tmpl          ← turns into YOUR aios.yaml (folder B below), not this one
│   └── .claude/CLAUDE.md.tmpl  ← turns into YOUR .claude/CLAUDE.md (folder B below)
├── validation/                 ← checkers you point at YOUR workspace, from here
│                                 (or just run `aios validate` from inside folder B —
│                                  folder B never gets its own copy of these)
└── docs/                       ← this file, and the rest of the toolkit's own docs
```

**Folder B — your real workspace, created by step 5.** A brand-new folder,
usually `~/Projects/<your-slug>/`, with its **own separate git repo**. This is
where you work every day, and every file below is a real, filled-in file — none
of it is a template.

```
~/Projects/abe-workspace/       ← created FOR you by scaffold-project.sh — a new folder
├── aios.yaml                   ← HERE. At the top level. Real and filled in — not a template.
├── .env                        ← your API key goes here (you create it from .env.example)
├── 0-context/  1-inbox/  2-work/  3-log/  4-shared/  5-personal/   ← your spine (§2)
├── .claude/
│   ├── CLAUDE.md                ← real file, generated from the toolkit's CLAUDE.md.tmpl
│   └── rules/  skills/  rubrics/  memory/     ← the agent layer, copied in for you
└── README.md
```

**Straight answers to the exact questions that trip people up:**

- **"Is `aios.yaml` in the root, or in `/scaffold`?"** — The root of **folder B**
  (your workspace). It is never inside a `scaffold/` folder. Your workspace
  doesn't even *have* a `scaffold/` folder — that name only exists inside the
  toolkit (folder A).
- **"What's actually inside `/scaffold`?"** — Only templates: files ending in
  `.tmpl` with unfilled `{{PLACEHOLDER}}` markers, plus one filled worked
  example (`aios.yaml.example`). If you ever see a literal `{{...}}` in an
  error or in a file you're editing, a template got copied somewhere instead
  of generated — re-run `scaffold-project.sh` (see the Troubleshooting table).
- **"Is there a CLAUDE.md or README in `/scaffold` with instructions?"** — Not
  ones meant to be *read* directly. `scaffold/.claude/CLAUDE.md.tmpl` and
  `scaffold/README.md.tmpl` are templates that become your workspace's *real*
  `CLAUDE.md` and `README.md` once you scaffold (folder B). `scaffold/README.md`
  (no `.tmpl`) is the one real file in that folder, and it just explains the
  folder itself to a human poking around — it is not workspace setup
  instructions.

If you remember one thing from this section: **you clone a released toolkit, run
one command, and then live in the folder that command creates.**

---

## 2. What you're setting up

AIOS is a three-part system: **your individual workspace** (folder B above — one
per person, you work here and choose what leaves your machine), the **Team Brain**
(the one shared hub that receives everyone's pushes and answers questions across
the team), and the **public site** (docs/marketing). You only run the workspace
locally; the brain is hosted. See [`architecture.md`](architecture.md) for the
hub-and-spoke model.

Everything in the workspace carries an **access tier** that travels with the content:

| You write | Canonical | Syncs? |
|-----------|-----------|--------|
| `private` (consultant or employee) | `admin` | **never** — stays on your machine |
| `team` | `team` | yes — to the Team Brain |
| `client` (consultant) / `company` (employee) | `external` | yes — outward-facing |

**Hard rule:** `private`/`admin` content **never** leaves your machine, and **untagged
content never syncs** (default-deny). The CLI enforces this before any network call,
and the brain independently rejects `admin` content with a `422`. Promotion is always
a deliberate `aios push`.

---

## 3. Prerequisites

- **Node ≥ 22** (`package.json` → `engines.node`). The `aios` CLI itself uses only
  Node built-ins (fetch, crypto, fs) for sync, so for that you just need Node on
  `PATH`. **Node is also what the write-time guard hook falls back to when `jq` is
  absent, so it is not optional** — see the next bullet.
- **git**.
- **`jq` — recommended, not required.** `hooks/team-ops-guard.sh` (the PreToolUse guard
  that blocks secrets and admin-tier content before they are written) parses the tool
  event with `jq` when it is present and with `node` when it is not. Install `jq` if you
  want the cheaper path on a hook that fires on every write:
  `apt-get install -y jq` / `brew install jq` / `apk add jq`. macOS 15 (Sequoia) and
  later ship it at `/usr/bin/jq`; earlier macOS, bare `node:*` Docker images,
  Debian/Ubuntu slim and Alpine do not.
  With **neither** `jq` nor `node` on `PATH` the guard has no way to read its input, so
  it **blocks the write** with `AIOS_GUARD_NO_JSON_PARSER` rather than waving it
  through — a guard that cannot parse its input must never report "allow". Before the
  node fallback landed it silently allowed instead, which meant secret scanning was off
  on any machine without `jq` and nothing said so.
- **`npm install` is required before running the validators from a git-clone checkout.**
  It is *not* needed for scaffolding or for `aios` sync. The npm install path
  (`npm i -g @aiosbrain/aios`) ships its dependencies resolved, so it needs no extra step.
- Once installed, `npm run help` lists every script grouped by category (Core / Dev /
  Build / Internal) — a bare `npm run` prints the same ~18 scripts with no grouping.

---

## 4. Get your Team Brain API key

A Team Brain **admin** issues you a per-member key. The key looks like
`aios_<key_id>_<secret>` and is **shown once** — copy it immediately. It is scoped to
**one team** (ours is `aios`).

**Ask John** to issue your key. For reference, the admin runs these *in the brain repo*
(`aios-team-brain`), not here:

```bash
# in aios-team-brain
npm run admin -- create-member abe@example.com --name "Abe" --handle abe --role member --team aios
npm run admin -- issue-key abe@example.com --team aios
```

The `issue-key` output is your `aios_…` key. Keep it out of git — it goes in `.env`
(gitignored), never in `aios.yaml`.

---

## 5. Scaffold your workspace

This is the one command from **folder A** (the toolkit) that builds **folder B**
(your real workspace) — see §1 if that distinction is still fuzzy.

You're an employee/contributor (not a client-facing consultant), so use
`--context employee`. From the tagged toolkit checkout:

```bash
scripts/scaffold-project.sh --context employee \
  --slug abe-workspace \
  --owner abe \
  --team "sam,jordan" \
  --output ~/Projects/abe-workspace
```

Flags (verified against `scripts/scaffold-project.sh`):

- `--context employee` — selects the employee spine skin (role/OKRs in `0-context`,
  company-shared `4-shared`, outward tier `company`). `consultant` is the other option.
- `--slug` — your workspace folder/identifier. **Required.**
- `--owner` — your member handle (becomes a workspace member so identity resolution
  passes — see Troubleshooting). **Required.**
- `--team "sam,jordan"` — *context only*; your teammates have their own workspaces.
  Optional.
- `--brain-url` / `--team-id` — legacy-compatible optional fields. Prefer connecting later with
  `aios onboard`: it normalizes and asks you to confirm a remote origin before saving it. A remote
  `--brain-url` is rejected in scripted/non-TTY scaffolds because an agent cannot approve trust for you.
- `--output` — where to create it (defaults to `~/Projects/<slug>`).

Add `--dry-run` to preview the spine without creating anything.

**What gets created** — the numbered spine (raw → refined), each folder's default tier:

| # | Folder | Holds | Default tier |
|---|--------|-------|--------------|
| 0 | `0-context/` | your role + OKRs (employee skin) | `team` |
| 1 | `1-inbox/` | raw inputs: transcripts, reference, from-brain | private |
| 2 | `2-work/` | your deliverables and working docs | `team` |
| 3 | `3-log/` | decision log, tasks (sync), hours (local) | private / `team` per file |
| 4 | `4-shared/` | company-shared, outward-facing | `external` (`company`) |
| 5 | `5-personal/` | private scratch — **never syncs** | private |

The scaffolder also drops in the `.claude/` agent layer (rules, skills, rubrics), the
governance hook, `aios.yaml` **(a real, filled-in file at the workspace root — not a
template, and not inside a `scaffold/` folder)**, `.env.example` **and a starter `.env`
copied from it** (so `npm run gui`/`aios onboard` never crash on a missing `.env` before
you've set anything), and an initial git commit. When it finishes it prints:

```
Workspace ready: ~/Projects/abe-workspace

Next: Run `aios status` to see what is local, private, and eligible to share.
```

One line, not a checklist — it reflects whatever you actually still need to do next
(standalone or connected), computed fresh each time
you scaffold or run `aios onboard --print-next-only`.

The scaffolder also copies `bin/aios`, `.envrc` (`PATH_add bin`), and offers to run
`scripts/install-aios-shell.sh` (adds an `aios()` function to `~/.zshrc` that finds
`aios.yaml` walking up from cwd — no `npm run --` needed).

### 5b. Check the workspace

```bash
cd ~/Projects/abe-workspace
aios validate
```

Exit 0 means every OGR validator passed. `--critical` runs the secrets scan alone;
`--quick` runs the folder-structure check alone.

Run this from **inside your workspace** — `aios validate` finds the validators inside
whichever toolkit is installed, so you never need the toolkit's path. That distinction
matters: **your workspace has no `validation/validate-all.sh`.** Its `validation/`
folder holds only `secret-patterns.txt`, so `validation/validate-all.sh .` from folder
B fails with `No such file or directory`, and on a global npm install the real script
is buried at `$(npm root --global)/@aiosbrain/aios/validation/validate-all.sh` — a
location that depends on your Node install (nvm, fnm, Homebrew and Windows all put it
somewhere different), which is exactly why you should not have to name it. If you are
sitting in a toolkit checkout (folder A) you can still call it directly, but you must
point it at folder B: `validation/validate-all.sh ~/Projects/abe-workspace`.

---

## 6. Connect to the brain

`cd ~/Projects/abe-workspace` — you are now inside **folder B**, your real
workspace, not the toolkit. Inspect before changing it:

```bash
aios onboard --inspect --json
aios onboard
```

The first command is dependency-free and read-only. The guided command explains what it found,
offers Personal / Join / Create, and requires you to confirm the exact canonical Brain origin
before it persists a newly entered remote value. It may validate the connection with `/api/v1/me`;
it never runs `aios push`.

**`.env`** (gitignored — never commit it) — the scaffolder already created this for
you (copied from `.env.example`), so just fill in the real values:

```dotenv
# .env  — fake values shown; use the real key John issued you
AIOS_API_KEY=aios_demo_xxxxxxxx
AIOS_MEMBER=abe
```

**`aios.yaml`** — the guided flow fills the canonical `brain_url`. A done-looking config
(note `api_key_env` names the *env var*, never the secret):

```yaml
version: 1
brain_url: "https://brain.aios.example.com"
api_key_env: AIOS_API_KEY

agent_runtime: claude-code
agent_personality: "aios"

sync_tiers:
  - team
  - company        # employee outward tier (→ external)

sync_include:
  - 0-context
  - 2-work
  - 3-log/decision-log.md
  - 3-log/tasks-team.md   # 3-log/tasks-private.md and 5-personal/tasks.md stay unlisted — never sync
  - 4-shared
  - .claude/memory
sync_exclude:
  - 5-personal

member: ""          # resolved from $AIOS_MEMBER / git config aios.member / git user.name
context: employee
```

> Leave `brain_url` empty to stay fully offline — every non-sync part of the workspace
> still works (see §8).

> **Rehearsing against staging.** To test a push without touching live team data, set
> `brain_url` to the staging brain — `https://aios-team-brain-staging.up.railway.app` — a
> separate deployment with its own database. It is invite-only, so you also need a member
> row and an API key issued **on staging**; a production key will not authenticate there.

A filled reference also lives at
[`scaffold/aios.yaml.example`](../scaffold/aios.yaml.example) — **in the toolkit
(folder A)**, for you to eyeball or hand-copy values from. Don't copy
[`scaffold/aios.yaml.tmpl`](../scaffold/aios.yaml.tmpl) itself; it's unfilled
(see §1).

---

## 7. Your first push

Create something to push — say a deliverable in `2-work/`:

```bash
$ aios status

new (0):
modified (0):
blocked (1):
  2-work/sprint-plan.md — no `access:` frontmatter (default-deny)

clean (already synced): 0

blocked files never leave this machine. To sync one: add `access: team`
(or `external`) frontmatter — promotion is deliberate.
```

It's **blocked** because it has no tier. Add frontmatter to make it team-visible:

```yaml
---
status: draft
owner: abe
access: team
---
```

Re-run status — now it's eligible:

```bash
$ aios status

new (1):
  2-work/sprint-plan.md [deliverable, team]

modified (0):
blocked (0):
clean (already synced): 0
```

Push it:

```bash
$ aios push
pushed 1 item (new=1 modified=0) → https://brain.aios.example.com
```

Pull team updates (writes into `1-inbox/from-brain/`, append-only) and ask the brain
a question:

```bash
$ aios pull
pulled 3 items → 1-inbox/from-brain/

$ aios query "what's blocking sprint 2?"
…grounded answer with [S#] citations from tier-visible items…
```

That's your first push live on the Team Brain.

`aios review` does the same as `push` but interactively — toggle each file's inclusion,
then push the selection. Run `aios --help` for the full command list.

---

## 8. Working offline

No brain needed for: **scaffolding**, `aios validate`, the harness
skills, the whole **operator loop** (`aios loop daily|collect|weekly|verify|writeback`)
and **human-operating layer** (`aios asks`, `aios mode`, `aios decisions`, `aios spec`,
`aios rails`, `aios time`), `aios analyze` (agentic-maturity report from local logs),
`aios export-okf`, `aios graph`, `aios assess-codebase`, and `aios learn`. Only
**`push`**, **`pull`**, and **`query`** require a configured `brain_url` + key. Leave
`brain_url` empty to run fully standalone.

> Once you're set up, the [operating manual](GUIDE.md) is the task-oriented tour of all of
> the above — organized around your day, with real output and diagrams.

---

## 9. Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| `401 unauthorized` | Bad, revoked, or expired key, or a configured non-empty `X-AIOS-Team` value does not match the key's team UUID/slug. Re-check `AIOS_API_KEY`; remove/fix stale `team_id` only if your existing config sends one. |
| `422 forbidden_tier` on push | You tried to push `private`/`admin`-tier (or untagged) content. **By design** — admin content never leaves the machine. Retag to `team`/`external` only if it really should be shared. |
| `member '<x>' is not in … members` | Your identity isn't on the workspace roster. The CLI resolves member from `$AIOS_MEMBER` → `aios.yaml` `member:` → `git config aios.member` → `git user.name`, then checks it against the workspace member list. Fix your identity or add yourself via `--owner`/the member list. |
| `cannot resolve member identity` | None of the sources above is set. Set one: `export AIOS_MEMBER=abe` or `git config aios.member abe`. |
| Key not yet issued | You haven't been provisioned. Ask John to run `create-member` then `issue-key` (§4). |
| `unknown sync tier '{{...}}'` (or any `{{...}}` in an error) | `aios.yaml` was copied straight from `scaffold/aios.yaml.tmpl` instead of being generated — its `{{PLACEHOLDER}}` markers were never substituted. This is the #1 mix-up in §1: `scaffold/` (folder A) is templates only, `aios.yaml` belongs in your workspace root (folder B). Re-run `scripts/scaffold-project.sh` (§5), or hand-fill a fresh `aios.yaml` from the worked example at `scaffold/aios.yaml.example`. |

---

## 10. Next: contribute to the platform

Once your first push is live, start contributing. The canonical end-to-end path (understand →
get access → scaffold → sync → first PR) is the website's
[Onboarding a contributor](https://aios-alpha.github.io/getting-started/onboarding-a-contributor/)
page. Each repo also has its own contributor guide:

- **`aios-workspace`** (this repo) — CLI, scaffold, validators, harness skills.
  See [`CONTRIBUTING.md`](../CONTRIBUTING.md).
- **`aios-workspace-gui`** — the standalone GUI repo
  ([github.com/aiosbrain/aios-workspace-gui](https://github.com/aiosbrain/aios-workspace-gui)),
  cut from this repo with filtered history. It is the GUI's only home — `gui/` and
  `src-tauri/` were deleted here in AIO-612. Seam contract:
  [`gui-toolkit-contract.md`](gui-toolkit-contract.md).
- **`aios-team-brain`** — Next.js dashboard, ingest pipeline, query layer.
  See its `DEVELOPMENT.md` (local setup + test tiers) and `CONTRIBUTING.md` (PR gates).
- **`aios-alpha.github.io`** — the public docs (this getting-started path + the site).

The pinned sync contract is [`brain-api.md`](brain-api.md) — any change to the sync
protocol is a versioned change there *first*. For wiring integrations (Slack, Jira,
Notion, …) see [`integrations.md`](integrations.md).

# What this folder is

**This is not a workspace. Nothing in this folder is meant to be used as-is.**

`scaffold/` holds the *templates* that `../scripts/scaffold-project.sh` reads to
generate a brand-new, real AIOS workspace somewhere else on your machine (by
default `~/Projects/<your-slug>/`). You run one script; it stamps these
templates into a separate folder with the placeholders filled in. You never
edit a file in here to set up your own workspace, and your generated workspace
will **not** contain a folder called `scaffold/` — its contents get expanded
into real files at the top level of your new workspace instead.

If you're trying to find your own `aios.yaml`, `CLAUDE.md`, or `README.md` —
they don't live here. Run the scaffolder (see
[`docs/GETTING-STARTED.md`](../docs/GETTING-STARTED.md)) and look in the
workspace folder it creates.

## What's actually in here

| File / folder | Becomes, in your generated workspace |
|---|---|
| `aios.yaml.tmpl` | `aios.yaml` (Team Brain connection config) — **unfilled**, has `{{PLACEHOLDER}}` markers. Never copy this file directly; `scaffold-project.sh` fills it in for you. |
| `aios.yaml.example` | *(reference only, not copied)* — a fully filled-in worked example, for eyeballing or hand-filling `aios.yaml` if you ever need to. |
| `README.md.tmpl` | `README.md` at your workspace root |
| `.env.example` | `.env.example` — you `cp` this to `.env` yourself and fill in your real API key |
| `.mcp.json`, `.mcp.example.json` | `.mcp.json` / `.mcp.example.json` |
| `contacts.yaml.tmpl`, `engagement.yaml.tmpl`, `project.yaml.tmpl`, `workspace.yaml.tmpl` | the matching `*.yaml` files at your workspace root |
| `.claude/CLAUDE.md.tmpl` | `.claude/CLAUDE.md` — your workspace's real agent instructions |
| `.claude/rules/`, `.claude/skills/`, `.claude/rubrics/`, `.claude/memory/`, `.claude/personalities/` | copied as-is into your workspace's `.claude/` — this is the agent layer (governance rules, harness skills, self-correction rubrics, memory scaffolding) |
| `.claude/settings.json`, `.claude/integrations.json`, `.claude/INTEGRATIONS.md` | copied as-is into your workspace's `.claude/` |

Any file ending in `.tmpl` has unfilled `{{PLACEHOLDER}}` markers — those are
not valid config values. If you ever see a literal `{{...}}` in an error
message or in a file you're editing, something got copied from here instead
of generated. Re-run the scaffolder.

**Changing product behavior?** Edit the template here, not a stamped copy in
someone's workspace — see `../CLAUDE.md` §"Edit the template, not a stamped
copy."

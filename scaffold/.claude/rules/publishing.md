# Rule: Publishing & Promotion

Content matures by moving through the numbered spine, gaining refinement and a
wider audience at each step. Promotion is deliberate, never automatic — nothing
leaves your workspace until you choose to `aios push` it.

## Flow

```
5-personal/        raw capture & private drafts (never syncs)
        ↓
2-work/            your work, team-visible once tagged access: team
        ↓
4-shared/          outward-facing — client (consultant) or company (employee)
```

## Promotion rules
- **Personal → Team:** when a draft is team-relevant, move it from `5-personal/`
  into `2-work/` and tag `access: team`. A teammate reviews.
- **Team → Outward:** only deliberately. Set `access: client` (consultant) or
  `access: company` (employee), record `approved_by`, and place it in `4-shared/`.
- **Never promoted:** pricing and rate detail, internal deliberation, anything
  tagged `access: private` (canonical `admin`). These never sync, by default.

## Outward-first ordering
In rosters, tables, and recipient lists, list the outward party's people
(the client, or the wider company) before your immediate delivery team. The work
serves them; the team supports it.

The `scope-creep` skill checks `2-work/` output against the engagement's scope
baseline (`0-context/scope-baseline.md`) before it is surfaced — consultant
context only.

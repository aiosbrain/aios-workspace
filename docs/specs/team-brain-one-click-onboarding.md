# Spec — create and connect a Team Brain from individual onboarding

Linear: AIO-445

## Why

Individual onboarding currently treats **Create** as a guide-only exit. A first-time user who needs
a Team Brain must leave the workspace flow, provision Railway through a CLI path that pauses for a
GitHub fork/deploy, then manually return. The product should instead offer an official Railway
template deployment and resume the existing, human-approved Brain connection flow.

## What

Ship one end-to-end outcome across `aios-team-brain`, `aios-workspace`, and `aios-website`:

1. An official Railway template provisions Team Brain plus Postgres from the public Team Brain
   repository. It asks for team/admin identity and an admin password, generates application secrets,
   applies schema, creates the initial team/admin idempotently, and exposes a public domain.
2. Onboarding contract v3 changes Create from `guide-only` to `railway-template`. The CLI explains
   the external action, obtains human approval before opening the deploy URL, prints the URL when a
   browser cannot be opened, then collects Brain URL and API key and validates `GET /api/v1/me` via
   the same canonical Join path. It never runs `aios push` during onboarding.
3. Website and Team Brain prompts, fixtures, animation, and guide consume the same v3 behavior and
   describe one deploy button plus the required Railway form and API-key connection step.

## Public interfaces

`docs/contract/onboarding-orchestration.json` becomes version 3. Its `create` object is:

```json
{
  "mode": "railway-template",
  "provider": "railway",
  "deployUrl": "https://aiosbrain.dev/deploy/team-brain/",
  "prerequisites": {
    "activeRailwayPlan": true,
    "plansUrl": "https://railway.com/workspace/plans"
  },
  "guide": "https://aiosbrain.dev/guides/team-brain/",
  "resume": {
    "required": ["brainUrl", "apiKey"],
    "validationRequest": "GET /api/v1/me"
  }
}
```

The Team Brain repository records the canonical template URL and configuration contract. Required
platform setup is an active Railway plan in the target workspace, verified before the deploy handoff.
The installer links directly to `https://railway.com/workspace/plans`; an expired trial cannot create
the sandbox project. Required
operator inputs are `TEAM_NAME`, `TEAM_SLUG`, `ADMIN_NAME`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD`.
`AUTH_SECRET` and `SECRETS_KEY` are generated secrets; `DATABASE_URL` references Postgres; `APP_URL`
references the Railway public domain. A user-supplied password is never printed to deployment logs.

## Acceptance criteria

- Contract tests in all three repositories accept only version 3, require the Railway deploy URL,
  require the active Railway plan prerequisite and plans URL, and reject the obsolete
  `Create is guide-only` marker.
- Workspace transcript tests cover approval granted/declined, browser-open success/fallback, delayed
  deployment, invalid URL/key, and successful resume through `GET /api/v1/me` without `aios push`.
- Workspace onboarding tests explicitly clear or inject `AIOS_BRAIN_URL`, `AIOS_API_KEY`, and related
  environment values so ambient credentials cannot override fixtures.
- Team Brain setup tests prove the Railway path no longer pauses for a GitHub fork, required template
  variables are documented, a supplied admin password is not logged, and restart bootstrap preserves
  an existing credential.
- Website transcript, onboarding-contract, docs, and production-build checks pass against v3.
- A disposable Railway project with a unique `aios-sandbox-aio445-` prefix reaches a
  healthy public URL, supports admin login and API-key issuance, passes `GET /api/v1/me`, and supports
  a synthetic post-onboarding push/query/pull round trip.
- The sandbox is deleted only after its exact project ID and test-only resources are verified and
  evidence is captured. The existing production AIOS Railway project is never mutated by CLI deploy,
  redeploy, down, or delete operations.
- The Team Brain change is merged and tagged before workspace release; the workspace release is
  merged and tagged before the website documents the capability.

## Integration points

- `docs/contract/onboarding-orchestration.json` is the cross-repository source of
  truth; website and Team Brain fixtures mirror it.
- `scripts/onboard-command.mjs` owns CLI orchestration and must reuse the current Join
  validation path rather than adding an ad-hoc Brain HTTP client.
- The Team Brain bootstrap module owns idempotent team/admin creation, its Railway configuration
  owns repository-side build/deploy behavior, and its architecture map records the new flow.
- The website agent-setup prompt module remains the public copy-paste prompt source.

## Dependencies and ordering

Dependencies: existing Team Brain setup/bootstrap, Railway account access, the published public GitHub
repositories, and AIO-445. Merge order is Team Brain → Railway template verification → workspace/npm
release → website. If Railway template publication requires an interactive account-owner approval,
all code, configuration, tests, and a draft template are completed first and that single approval is
reported as the blocker.

## Scope

In scope: Railway template deployment, Create orchestration, contract/prompt/docs synchronization,
sandbox verification, release evidence, and a 1–2 minute Loom. Out of scope: automatic browser-to-CLI
callbacks, billing/payment automation, production data migration, Team Brain API protocol changes,
automatic onboarding pushes, and replacing the local curl installer.

## Security and failure posture

The flow keeps the existing human gate for external actions and canonical-origin approval. Admin
credentials and generated secrets remain Railway variables and are never committed. A deployment
failure leaves the local workspace unchanged and offers the deploy URL plus self-host guide. Unknown
or invalid Brain origins and API keys fail closed before configuration is persisted.

## Build-with

Build-with: Codex, high effort. This is one tightly coupled cross-repository outcome tracked by
AIO-445, implemented in hydrated worktrees with reviewed PRs and observable sandbox evidence.

## Testability

Run the named repository test suites and builds, followed by the disposable Railway scenario above.
Capture command output, commit SHAs, deployment/project IDs, health response, authenticated team
identity, synthetic sync result, screenshots, and teardown confirmation in the AIO-445 evidence log.

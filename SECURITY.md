# Security Policy

## Reporting a vulnerability

Please report security issues **privately**. Do not open a public GitHub issue for a
suspected vulnerability.

- Use **GitHub's private vulnerability reporting**: the repository's **Security** tab →
  **Report a vulnerability**. Include a description, reproduction steps, and impact.
- We aim to acknowledge within 3 business days and to agree on a disclosure timeline with you.
- Please give us a reasonable window to ship a fix before any public disclosure.

## Supported versions

This toolkit is pre-1.0 and ships from `main`. Security fixes land on `main`; run the latest
`main` (or the latest tagged release once one exists).

## Security model (what the workspace guarantees)

The workspace is a **local** toolkit. Its core safety property is that **nothing leaves your
machine until you deliberately `aios push`**, and even then only tier-tagged content.

- **Default-deny sync.** Content with no resolvable `access:` frontmatter is never pushed;
  `admin`/`private` content never syncs; only tiers listed in `aios.yaml: sync_tiers` are
  eligible. This gate lives in `scripts/aios.mjs` (`buildPlan`) and is verified by
  `test/sync-plan.test.mjs`. The Team Brain independently rejects `admin`-tier with 422.
- **Write-time guards (fail-closed).** A PreToolUse hook (`hooks/team-ops-guard.sh`) blocks
  writes that contain secrets or that place `admin`-tier content into shared directories.
  Validators (`validation/validate-all.sh` → `check-secrets.sh`, frontmatter, config) must pass.
- **Confidentiality leak gate.** `scripts/leak-gate.sh` scans for NDA-protected names/identifiers
  before content can be shared; it is fail-closed (non-zero exit blocks).
- **API keys are referenced, never stored.** `aios.yaml` holds `api_key_env` — the *name* of an
  environment variable — never the key itself. Keys come from the environment / `.env` (git-ignored).
- **Local GUI is localhost-only.** `gui/server` binds `127.0.0.1` exclusively and gates the
  websocket/HTTP surface on a per-session token. It is a single-user local cockpit — do not
  reverse-proxy it onto a network.

## Secrets hygiene

- Never commit real secrets. `.env`, `.env.local`, and `.env.keys` are git-ignored; only
  `*.example` files are tracked. CI runs the leak gate and secret-pattern checks on every PR.
- If you find a secret in a draft, the write hook should have blocked it — report a miss as a bug.

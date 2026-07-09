---
name: demo-preflight-buildcheck
description: Check whether gitignored build artifacts (e.g. dist/) that runtime code depends on are present and fresh, in this checkout and every registered worktree. Use before a demo, on any fresh clone/worktree, or when the user asks "before the demo", "pre-demo check", "will this work on a fresh clone", "check build artifacts", or invokes /demo-preflight. Mechanical, static check — flags missing/stale artifacts and prints the fix command; does not silently rebuild.
---

You are checking whether runtime code in this repo will hard-fail because a gitignored build artifact is missing or stale — the failure mode that killed `aios loop`/asks/decisions demos when `dist/` wasn't built (`loadOperatorLoop → die('operator-loop is not built — run: npm run build:loop')`), rediscovered independently by two audit passes on 2026-07-09.

**This skill flags. It does not auto-build without telling you first.**

## Step 1 — find die()/throw sites that reference gitignored paths

```bash
cat .gitignore
grep -rn "not built\|is not built\|run: npm run build" scripts/ src/ gui/ --include=*.mjs --include=*.ts
```

Then a generic pass for code that requires/imports a path under a gitignored dir (usually `dist/`):

```bash
grep -rn "require(.*dist/\|from ['\"].*dist/\|import(.*dist/" scripts/ src/ gui/ --include=*.mjs --include=*.ts
```

Cross-reference each hit's path against `.gitignore` — only paths actually gitignored are in scope.

## Step 2 — is the producing script automated or manual?

For each build target found in step 1, check `package.json`:

```bash
grep -n "\"build\|\"postinstall\|\"prepare" package.json
```

Classify: does `postinstall`/`prepare`/CI run the producing script automatically, or is it manual-only (e.g. `npm run build:loop` that nothing calls)? Manual-only is the risk case — note it explicitly.

## Step 3 — check presence AND freshness in the current checkout

```bash
ls -la dist/operator-loop/index.js 2>/dev/null || echo "MISSING: dist/operator-loop/index.js"
find dist -type f -newer /dev/null 2>/dev/null | xargs -I{} stat -f '%m %N' {} 2>/dev/null | sort -rn | head -1
find src/operator-loop -name '*.ts' -newer dist/operator-loop/index.js 2>/dev/null
```

Report one of three states per artifact: **fresh** (dist newer than all matching src), **stale** (a src file under `src/operator-loop/**/*.ts` is newer than the dist artifact), or **missing** (no dist artifact at all). Apply the same pattern to any other build target found in step 1, not just operator-loop.

## Step 4 — repeat for every registered worktree

```bash
git worktree list
```

For each worktree path, re-run step 3's presence/freshness check against that path. Worktrees hydrate `.env`/config via `link-worktree-env.sh` but **never run builds** — a worktree can look fully configured and still be missing `dist/`.

## Step 5 — report and offer the fix

For anything missing or stale, print the exact fix command (e.g. `npm run build:loop`) per affected checkout/worktree. Ask before running it — never run a build silently. If everything is fresh across every checkout and worktree, say so plainly.

## Output format

```
CHECKOUT                                          ARTIFACT                        STATE     FIX
aios-workspace                                    dist/operator-loop/index.js     stale     npm run build:loop
aios-workspace-feat-audit-skills (this worktree)  dist/operator-loop/index.js     missing   npm run build:loop
aios-workspace-onboarding-marathon-dogfood        dist/operator-loop/index.js     fresh     —
```

Note in the summary: this check is mechanical and static (glob + mtime compare) — it is a candidate to become a plain pre-demo hook rather than an agent skill.

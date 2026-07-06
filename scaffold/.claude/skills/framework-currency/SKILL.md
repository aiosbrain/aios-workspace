---
name: framework-currency
version: 1.0.0
access: team
description: Known framework gotchas and stale patterns. Fast lookup before writing framework code. Use when creating or modifying files that import from Next.js, Supabase, React, or other tracked frameworks.
triggers:
  - framework gotcha
  - stale pattern
  - next.js version
  - supabase pattern
---

# Framework Currency

Quick-reference for patterns that changed between major versions. Check here first before writing framework code. If the pattern you need isn't listed, query Context7 and add it.

**Last verified:** 2026-03-13

---

## Next.js 16.x

| Stale Pattern | Current Pattern | Notes |
|---|---|---|
| `middleware.ts` (file) | `proxy.ts` | Renamed in Next.js 16. Export `proxy()` not `middleware()` |
| `middleware()` (function) | `proxy()` | Function name matches file name |
| `NextResponse.next()` in middleware | Return `Response` or use proxy helpers | Proxy uses standard Web API Response |
| `getServerSideProps` | Server Components | App Router only. No more data-fetching exports |
| `getStaticProps` / `getStaticPaths` | `generateStaticParams` + fetch in RSC | App Router only |

## Supabase (@supabase/ssr)

| Stale Pattern | Current Pattern | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Env var renamed |
| `supabase.auth.getSession()` | `supabase.auth.getUser()` | Server-side only. `getSession` reads unverified cookie, `getUser` validates JWT |
| No proxy/middleware | Must have `proxy.ts` with `createServerClient` | Session refresh requires proxy. Without it, sessions silently expire |
| `createMiddlewareClient` | `createServerClient` in proxy.ts | Old helper removed |
| `createClientComponentClient` | `createBrowserClient` | From `@supabase/ssr`, not `@supabase/auth-helpers-nextjs` |
| `SUPABASE_SERVICE_ROLE_KEY` | `SUPABASE_SECRET_KEY` | New `sb_secret_...` keys (June 2025). Not JWTs. Browser-blocked, instant revocation. Legacy keys deleted late 2026 |

## React 19.x

| Stale Pattern | Current Pattern | Notes |
|---|---|---|
| `forwardRef` | `ref` as regular prop | `forwardRef` no longer needed in React 19 |
| `React.FC<Props>` | Inline props typing | `FC` removed `children` from type |
| `useContext(Ctx)` | `use(Ctx)` | New `use` hook works with context and promises |
| `<Context.Provider>` | `<Context>` directly | Provider wrapper removed in React 19 |

---

## Adding New Entries

When Context7 or docs reveal a stale pattern not listed here:

1. Add a row to the relevant framework table (or create a new `##` section)
2. Include the stale pattern, current replacement, and a short note
3. Update "Last verified" date at the top
4. Keep entries sorted by how commonly they're encountered

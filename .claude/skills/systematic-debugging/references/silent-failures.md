# Silent failures — when the runtime lies

A *null* result (no output, no error, a breakpoint that never fires) is only evidence if your
observation tooling actually works. These are the patterns that stay green while the behaviour they
claim to guard is broken. Consult the section for your runtime before concluding "nothing happened."
Distilled from oh-my-opencode `debugging`'s runtime references.

## Node / tsx / ts-node / Bun / Deno

**The tsx + `node inspect` source-map trap (costs people days).** `tsx` transpiles each `.ts` on the
fly with an inline source map. V8 registers the module under its `.ts` path (so it shows in the
debugger's script list), **but the `node inspect` CLI does not resolve source-map line numbers
reliably** — `sb('session.ts', 285)` shows a "pending" breakpoint that never fires. The list happily
displays it; it isn't set. Workarounds: a `debugger;` statement in source (most reliable — journal +
revert), Chrome DevTools GUI (`chrome://inspect`), or debug the built `dist/` JS.

Silent-failure signatures to check before trusting a green run:

| Pattern | Why it's silent |
|---|---|
| HTTP 200 with an empty/partial body | The handler swallowed an error and returned a default |
| `usage: { totalTokens: 0 }` from an SDK call | The call was stubbed/short-circuited, not actually made |
| `void somePromise()` / floating promise | Rejection is never observed; the failure vanishes |
| `try { await x() } catch {}` | Empty catch discards the real error |
| A logger with no transport/handler configured | "Logs" that write nowhere |

## Python (CPython 3.9+, pytest, asyncio, FastAPI/Django)

| Pattern | Why it's silent |
|---|---|
| `except Exception: pass` / bare `except: pass` | Discards every error, including `KeyboardInterrupt` |
| `logging.exception(...)` with no handler attached | Writes nowhere |
| `asyncio.create_task(coro)` without storing the task | Task GC'd before completion; the exception is eaten at gc time |
| `asyncio.gather(t1, t2)` | Propagates the *first* exception while the other awaitables keep running unobserved (they are **not** cancelled) — use `return_exceptions=True` to see every outcome |

Tools: `PYTHONASYNCIODEBUG=1 python script.py` surfaces un-awaited coroutines and slow callbacks.
For a hung process, `py-spy dump --pid <pid>` prints every thread's stack right now (no breakpoints,
production-safe, zero code change) — usually enough to find the stuck call.

## Browser / UI

QA of a browser product must drive a real browser, never `curl` — the bug is usually that the UI
rendered nothing while the HTTP request was fine. Attach four listeners so "showed nothing" surfaces:
`console` (error), `pageerror`, `requestfailed`, and a failed-response check. Wait for *state*
(a selector, `networkidle`), never a fixed `sleep`. (See the `visual-qa` skill for capture drivers.)

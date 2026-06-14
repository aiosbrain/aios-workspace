# Desktop app (Tauri shell)

The desktop app makes AIOS Workspace usable without a terminal: double-click, pick
your workspace folder, and you're in the cockpit (chat · integrations · review & push).

It is a thin **Tauri** shell over the existing local server + SPA. On launch it:
1. resolves your workspace folder (remembered between runs; a native folder picker on
   first run);
2. starts the Node sidecar (`gui/server`) on a free `127.0.0.1` port with a one-shot
   session token — under `dotenvx run --` when the workspace has an encrypted `.env`,
   so the agent's MCP servers get decrypted provider tokens;
3. waits for it to come up and opens the window at the tokened localhost URL;
4. kills the sidecar when you close the window.

The agent runtime, skills, hooks, and connectors all live in the sidecar — unchanged.

## Develop

```bash
npm install                 # installs deps + @tauri-apps/cli
npm run app:dev             # builds the SPA, then `tauri dev` (hot-reload shell)
```

Requires the Rust toolchain (`rustup`); the default stable works.

> **Lockfile note:** `src-tauri/Cargo.lock` pins `alloc-stdlib = 0.2.2`. Tauri pulls
> `brotli 8.0.3` (asset compression), which mixes `alloc-no-stdlib` 2.0.4 (direct)
> with 3.0.0 (via `alloc-stdlib 0.2.3`) → a type-mismatch that fails to compile.
> Pinning `alloc-stdlib` to 0.2.2 keeps everything on `alloc-no-stdlib` 2.0.4. Keep
> the committed lockfile; don't `cargo update -p alloc-stdlib` until brotli ships a fix.

## Build a distributable

```bash
npm run app:build           # → src-tauri/target/release/bundle/ (.app/.dmg, .msi, .deb/.AppImage)
```

Replace the placeholder icon:

```bash
npm run app:icon -- path/to/icon-1024.png
```

## Known gaps before shipping to non-technical users

These are deliberately deferred (they pair with code-signing as the finishing pass):

- **Bundled Node runtime.** The shell currently launches the *system* `node` (resolved
  via a login shell, then common install paths). End users without Node installed
  can't run it yet — bundle a Node runtime as a Tauri sidecar binary and point
  `start_sidecar` at it.
- **Prune resources.** `tauri.conf.json` bundles the whole `node_modules` for correct
  module resolution; prune to runtime deps (`ws`, `@anthropic-ai/claude-agent-sdk` +
  transitive) to shrink the bundle.
- **Bundle `dotenvx`** (or vendor its resolution) so secret decryption doesn't depend
  on a system install.

## Code-signing & notarization (your finishing step)

Unsigned builds run locally but warn on other machines. To ship:

- **macOS** — set an Apple Developer ID in `tauri.conf.json` → `bundle.macOS`
  (`signingIdentity`) and notarize (`tauri build` integrates with `notarytool`; supply
  `APPLE_ID`, `APPLE_PASSWORD`/API key, `APPLE_TEAM_ID`).
- **Windows** — provide a signing certificate (`bundle.windows.certificateThumbprint`
  or a custom `signCommand`).

See the Tauri distribution docs for the current, exact fields.

# Architecture Context (Level 1 Knowledge Distillation)

## 1. System Overview
**GitOrbit** is an embedded, pure-JavaScript Git synchronization engine for Obsidian vaults. It connects directly to private GitHub repositories to synchronize notes, assets, and settings across desktop (Electron) and mobile (WebView) without requiring background CLI daemons or native git binaries.

## 2. Architectural Boundaries & Bridges

```
Obsidian App Vault
       │
       ▼
fs-adapter.ts ──[Wraps DataAdapter]──▶ In-Memory / File Promises
       │
       ▼
git-sync.ts   ──[isomorphic-git]────▶ Pure JS Git Operations (init, clone, fetch, merge, checkout, push)
       │
       ▼
gitHttp       ──[requestUrl]────────▶ GitHub Smart HTTP Transfer (Bypasses CORS, Mobile Safe)
       │
       ▼
github/api.ts & auth/github-device.ts ──▶ GitHub REST API & OAuth 2.0 Device Flow
```

## 3. Key Components
1. **`src/buffer-shim.ts`**: Injects `Buffer` polyfill into `globalThis.Buffer` before isomorphic-git imports evaluate. Resolves mobile runtime missing Node globals.
2. **`src/sync/fs-adapter.ts`**: Normalizes path delimiters (`\` vs `/`), strips vault base directory prefixes, creates parent directories on write, and translates Node `fs` calls to Obsidian's `vault.adapter` (`readBinary`, `writeBinary`, `stat`, `list`).
3. **`src/sync/git-sync.ts`**: Orchestrates git cycles. Executes `git.fetch` and `git.merge`, followed by `git.checkout({ force: true })` to ensure remote changes materialize on disk.
4. **`src/sync/queue.ts`**: Houses a thread-safe mutex and debouncing mechanism to coalesce rapid typing keystrokes into singular commit/push batches.
5. **`src/auth/github-device.ts`**: Executes OAuth 2.0 Device Grant (`/login/device/code`). Incorporates mobile error recovery against suspended network adapters.
6. **`src/ui/settings-tab.ts`**: Polished configuration view offering Dual Auth (OAuth Device Flow + Personal Access Token) and commit preferences.
7. **`src/ui/conflict-modal.ts`**: Side-by-side visual diff resolver using theme CSS variables.

## 4. Lifecycle & Hygiene Standards
- **Teardown**: On `onunload()`, `SyncQueue.flushNow()` drains remaining notes, `SyncQueue.destroy()` clears timers, and `StatusBarItem.destroy()` unbinds click event listeners to prevent memory leaks.
- **Credential Storage**: Credentials and tokens are stored in `.obsidian/plugins/gitorbit/data.json` and isolated via `.gitignore`.
- **Hot Reload**: Empty `.hotreload` marker enables instant in-place reload via PJ Eby's plugin.

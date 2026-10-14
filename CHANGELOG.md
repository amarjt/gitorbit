# Changelog

All notable changes to **GitOrbit** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.0.4] - 2026-10-15

### Fixed
- **Mobile Decompression Buffer Error**: Fixed `invalid compressed buffer: buffer error` caused by 0-byte corrupt objects and truncated stream decompression in Android/iOS WebViews.
- **Corrupted 0-Byte Object Auto-Purge**: In `fs-adapter`, detect when a read on `.git/objects/` encounters a 0-byte file (from previous interrupted writes or crashes), automatically delete the corrupt file, and throw `ENOENT` so isomorphic-git falls back cleanly to packed objects or retrieves fresh data.
- **Pristine ArrayBuffer Alignment**: Replaced ambiguous `Buffer.from(data).buffer.slice(...)` with zero-offset `new Uint8Array(data).buffer.slice(...)` copy, preventing buffer pool offset misalignment on mobile WebViews.
- **Recursive Directory Creation**: Added `ensureDir` helper in `fs-adapter` to guarantee nested git object folders (`.git/objects/xx`, `.git/objects/pack/`) are safely instantiated before writing binary files.
- **Dual String/Object Encoding Support**: Added explicit support for `options === 'utf8'` in `fs-adapter.readFile`, preventing raw buffer returns when isomorphic-git requests UTF-8 configuration files.

### Added
- **Automated Repository Self-Healing**: `repairGitRepository()` runs before every sync to sweep 0-byte loose objects, stale `.lock` files (`index.lock`, `HEAD.lock`), and truncated/orphan pack files.
- **Compressed Buffer Error Auto-Recovery**: If `sync()` ever encounters a `DecompressionError` or `buffer error`, it automatically executes a deep repository repair and retries the sync cycle seamlessly.
- **"Repair & Clean Repository" Settings Button & Command**: Added a manual maintenance action in GitOrbit settings and the Obsidian command palette (`GitOrbit: Repair and clean local git repository`) for on-demand repair.

## [1.0.3] - 2026-10-15

### Fixed
- **Merge Conflict Resolution Handling**: Gracefully catch `MergeConflictError` (e.g. `Automatic merge failed with one or more merge conflicts in the following files: Welcome.md`) and extract conflict files rather than aborting sync.
- **Two-Parent Merge Commits**: Ensured `resolveConflict()` records a proper 2-parent merge commit (`[localHead, remoteHead]`), guaranteeing that GitHub recognizes resolved conflicts as valid fast-forward merges.
- **Auto-Sync Conflict Trigger**: Connected `SyncQueue` to Obsidian UI so background sync conflicts automatically trigger the visual `ConflictModal`.

### Added
- **"Combine Both" Conflict Resolution**: Added a one-click "Combine Both" option in `ConflictModal` allowing users to concatenate local and remote notes without losing ideas from either device.
- **Conflict Status Bar Feedback**: Updated status bar badge to indicate exact number of files in conflict (e.g. `⚠ Conflict: 1 file(s)`).

## [1.0.2] - 2026-10-15

### Fixed
- **Mobile Non-Fast-Forward Push Rejection**: Resolved the error `GitOrbit: Sync error: push rejected because it was not a simple fast-forward. Use "force: true" to override.` experienced when syncing across mobile and desktop devices.
- **`safeFetch()` Return Value Resolution**: Fixed silent failure where `git.resolveRef("FETCH_HEAD")` threw and caught errors, causing the plugin to bypass remote merge and disk checkout cycles entirely.
- **Unrelated Histories Reconciliation**: Added `allowUnrelatedHistories: true` to `git.merge` so separate device initial commits merge cleanly without throwing `MergeNotSupportedError`.
- **Full History Clone**: Removed `depth: 1` shallow clone limitation to ensure complete commit ancestor graph availability for merge base calculations.
- **Automated Push Recovery**: Added an intelligent 1-pass auto-recovery retry loop when `PushRejectedError` occurs, automatically fetching the latest remote commit, executing a 3-way merge, writing updated files to disk, and retrying the push.

## [1.0.0] - 2026-10-13

### Added
- **Pure JavaScript Git Synchronization**: End-to-end sync using `isomorphic-git`, Obsidian's `DataAdapter`, and `requestUrl` (bypassing CORS, requiring no command-line git binaries).
- **Dual Authentication Suite**:
  - OAuth 2.0 Device Authorization Grant with in-browser one-time code verification.
  - Personal Access Token (PAT) authentication supporting private repositories (Classic and Fine-grained tokens).
- **Cross-Platform Buffer Polyfill**: Bundled `buffer` package with global injection shim (`src/buffer-shim.ts`) enabling full functionality on iOS and Android WebViews.
- **Resilient Mobile Device Flow Polling**: Network error handling (`try/catch` retry loop) preventing login freezes during app switching and background sleep on Android.
- **Physical Disk Checkout on Merge**: Working tree checkout (`git.checkout({ force: true })`) ensuring merged remote changes are written directly to Obsidian vault files on disk.
- **Visual Conflict Resolution Modal**: Side-by-side diff preview between local and remote versions with one-click resolution (`Keep Mine`, `Keep Theirs`, `Open in Editor`).
- **Real-Time Status Bar**: Interactive status bar item with 5 UX states (`idle`, `pulling`, `pushing`, `conflict`, `error`, `connecting`).
- **Debounced Sync Queue**: Mutex-locked file queue with configurable debounce delay (default: 3000ms).
- **Hot Reload Compatibility**: Bundled empty `.hotreload` marker for in-place live reloading.
- **Strict Teardown Hygiene**: Zero-leak lifecycle in `onunload()` releasing DOM listeners, clearing timers, and draining pending file queues.

# Changelog

All notable changes to **GitOrbit** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.2.1] - 2026-10-15

### Added
- **ObsSync Settings UI Alignment & Architectural Enhancements**:
  - **Scroll Position Preservation**: Nearest scroll ancestor tracking prevents jarring viewport jumps on option toggles, dropdown selections, or remote branch refreshes.
  - **Top-Level "Sync Now" CTA Banner**: When a repository and token are configured, a primary "Sync Now" CTA button is rendered directly at the top of the settings page for immediate synchronization without scrolling.
  - **Single-Row PAT Authorization**: Re-architected PAT authentication into a unified row with an inline `.setCta()` "Authorize" button that dynamically enables on input and automatically resolves account details, default author name/email, and repositories.
  - **Live Branch Management & Creation**: Added a branch dropdown with a `refresh-cw` button and "+ Create new branch…" option with real-time Git ref syntax validation and direct remote branch creation via the GitHub API.
  - **Stacked Full-Width Exclusions & Hints**: Applied `.gitorbit-setting-stacked` and monospace styling to the excluded patterns textarea, with contextual hints explaining mobile exclusion behavior.
  - **Scoped Mobile & Tablet Layout Fix**: Implemented responsive column layout rules (`.gitorbit-settings`) to prevent split-view flex stretching and card inflation on Android tablets and iPads.

## [1.2.0] - 2026-10-15

### Added
- **Repository Chooser & Custom Remote URL Support**:
  - **Dynamic Account Repository Chooser**: Automatically queries GitHub's API (`fetchUserRepos`) upon PAT authentication to populate an interactive dropdown of existing account repositories.
  - **Custom Clone URL Parsing & Live Hint**: Supports custom Git remote URLs (`https://`, `git@github.com:`, and shorthand `owner/repo`) with non-blocking, inline validation messages (`remoteUrlHint`).
  - **Auto-Provisioning**: Retained "+ Create new private repository" option to automatically create and initialize private vault repositories with one click.
- **Comprehensive Automatic Synchronization Suite**:
  - **Auto-Sync on Vault Edits**: Configurable toggle and debounce slider (1,000ms – 10,000ms) to sync changes seamlessly as you type without spamming Git commits.
  - **Sync on Startup**: Automatic pull and synchronization when Obsidian loads or the vault workspace is opened.
  - **Periodic Background Sync**: Zero-leak background timer (`periodicSync`) with selectable intervals (2, 5, 10, 15, 30, 60 minutes) to keep mobile and desktop vaults synchronized continuously without manual interaction.
- **Commit & Synchronization Customization**:
  - **Dynamic Commit Message Templates**: Configurable commit message template supporting `{{datetime}}` and `{{date}}` variables.
  - **Custom Author Identity**: Dedicated fields to configure Git author name and email.
  - **Sync Engine Selector**: Toggle between `"auto"`, `"git"` (isomorphic-git), and `"api"` (GitHub Git Data API) directly from settings.

## [1.1.1] - 2026-10-15

### Added
- **Mobile-Responsive Conflict Resolution UI**:
  - **Adaptive Segmented Tabs**: Replaced cramped side-by-side columns on mobile with a full-width segmented view switcher (`✨ Merged`, `📱 Local`, `☁️ Remote`, `🔍 Differences`, and `↔️ Side-by-Side` on desktop).
  - **In-Modal Merge Editor**: An interactive `<textarea>` displaying the merged note, allowing users to inspect or make quick touch edits right inside the modal on mobile before resolving.
  - **Responsive Button Grid**: Converted squashed horizontal button groups into an auto-wrapping button grid (`repeat(auto-fit, minmax(130px, 1fr))`) with comfortable touch targets.
  - **Dedicated Mobile Stylesheet (`styles.css`)**: Media queries (`@media screen and (max-width: 650px)`) ensuring seamless padding, typography, and button flow on phones and tablets.
- **Smart "Merge Extra Content" Engine (No Whole-Document Duplication)**:
  - Replaced naive concatenation (`ours + separator + theirs`) with an intelligent LCS line-alignment algorithm.
  - Automatically identifies common prefixes and suffixes, diffs the changed middle slice, and extracts **only the new/extra lines** from the remote version without repeating identical headers or existing text.
  - Dynamic button label showing exact line count: `Merge Extra (+N)` for total transparency.

## [1.1.0] - 2026-10-15

### Added
- **Dual Sync Engine Architecture (ObsSync Pattern)**:
  - **Mobile**: Introduced the dedicated **GitHub Git Data API Engine** (`GitHubApiSync`) that performs sync directly against GitHub's REST endpoints (`blobs` → `trees` → `commits` → `refs`).
  - **Desktop**: Preserved full local history and multi-parent merge capabilities using the **Git Engine** (`isomorphic-git`).
  - **Auto Engine Selection**: Added `syncEngine: "auto" | "git" | "api"` setting (defaults to `"auto"` which seamlessly activates Git on Desktop and GitHub API on Mobile).
- **Zero-Packfile Mobile Synchronization**: Mobile sync bypasses `.git/` packfile decompression entirely, eliminating `invalid compressed buffer: buffer error` (`Z_BUF_ERROR`) and out-of-memory crashes on Android WebView and iOS.
- **Micro-Memory Blob Streaming**:
  - Downloads blobs via `application/vnd.github.raw` directly into binary `Uint8Array`, avoiding intermediate base64 string allocations.
  - Chunked base64 uploads (49,152-byte chunks) to prevent Android V8 call stack exhaustion.
  - Automatic `yieldToGc()` macrotask breaks every 25 files to allow the V8 garbage collector to free ArrayBuffers.
- **Smart Mobile Exclusions**: Automatically excludes `.obsidian/` configuration bloat on mobile to prevent memory exhaustion and API rate-limit spikes while syncing all notes and attachments.
- **Live Vault Proxy (`createSyncAdapter`)**: Live note updates route through `vault.modify()` / `vault.delete()`, ensuring open notes and metadata caches instantly reflect remote changes without vault reloads.
- **Interactive API Conflict Resolution**: Full side-by-side conflict detection and resolution with direct GitHub commit generation on current remote head.
- **Configurable Git Branch**: Added setting to specify custom target branch (defaulting to `"main"`).

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

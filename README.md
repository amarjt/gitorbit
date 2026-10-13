# GitOrbit 🪐

> **Pure-JS Multi-Device GitHub Sync for Obsidian Vaults.**  
> Free forever. Works on Desktop (Windows, macOS, Linux) and Mobile (iOS, Android). Zero native binaries.

---

## 🚀 Key Highlights

- **Pure JavaScript Git Engine**: Powered by `isomorphic-git` and Obsidian's native `DataAdapter` + `requestUrl`. Does not require local git command-line binaries or desktop shells.
- **Full Cross-Platform Support**: Includes bundled Node.js `Buffer` polyfill and mobile WebView compatibility shims, allowing flawless execution on **iOS** and **Android**.
- **Dual Authentication**:
  - **1-Click Browser Authorization (OAuth Device Flow)**: Authorize seamlessly by entering an 8-character code at `github.com/login/device` without passwords or secret tokens.
  - **Personal Access Token (PAT)**: Direct token paste option with support for private repositories (Classic & Fine-grained tokens), granting 100% independence from any third-party OAuth app.
- **Resilient Mobile Polling**: Automatic network retry handling that prevents authorization timeouts when switching apps or putting mobile devices to sleep.
- **Physical Disk Checkout on Merge**: Fixed upstream desynchronization bug by ensuring 3-way and fast-forward remote merges write updated files to disk.
- **Background Auto-Sync**: Debounced silent background commits and pushes whenever notes are modified, created, renamed, or deleted.
- **Visual Conflict Resolver**: Side-by-side diff modal with local vs remote previews and one-click resolution (`Keep Mine`, `Keep Theirs`, `Open in Editor`).
- **Privacy & Security First**: Direct connection to your private GitHub repository. Live credentials stored strictly in local `data.json` and excluded from git.

---

## 🛠️ Quick Start

### 1. Enable Plugin in Obsidian
1. Open Obsidian **Settings** → **Community plugins**.
2. Refresh installed plugins and toggle **GitOrbit** to **ON**.
3. (Optional) Hot reload is enabled out of the box via the included `.hotreload` marker.

### 2. Connect Your GitHub Account
1. Open Obsidian **Settings** → **GitOrbit**.
2. Select your preferred **Authentication Method**:
   - **Browser Login (OAuth Device Flow)**: Click **Connect via Browser**, copy the one-time 8-character code, approve in GitHub, and you're done!
   - **Personal Access Token (PAT)**: Create a GitHub token with `repo` scope at [github.com/settings/tokens](https://github.com/settings/tokens), paste it, and click **Verify & Connect**.
3. GitOrbit will automatically detect or create a private GitHub repository named `obsidian-<your-vault-name>` and initiate your first vault snapshot.

### 3. Usage & Commands
- **Automatic Sync**: Edits are debounced (default: 3,000ms) and pushed silently in the background.
- **Pull on Startup**: The latest changes from GitHub are automatically pulled and checked out when Obsidian opens.
- **Command Palette (`Ctrl/Cmd + P`)**:
  - `GitOrbit: Sync vault now`: Triggers immediate fetch, merge, and push.
- **Status Bar Indicator**:
  - Click the bottom status bar item (`✓ GitOrbit`, `↓ Pulling…`, `↑ Pushing…`) at any time for manual sync.

---

## ⚙️ Configuration Reference

| Option | Default | Description |
|---|---|---|
| **Authentication Method** | `oauth` | Toggle between OAuth Device Flow and Personal Access Token (PAT). |
| **Automatic Synchronization** | `true` | Automatically commits and pushes after vault modifications. |
| **Sync Debounce (ms)** | `3000` | Inactivity delay in milliseconds before initiating commit & push. |
| **Excluded Patterns** | `.obsidian/workspace*`, `.obsidian/plugins/*/data.json`, `.git/**` | Glob patterns excluded from git tracking. |
| **Author Name & Email** | `GitOrbit` / `sync@gitorbit.local` | Git commit identity used for automatic sync commits. |

---

## 🏗️ Architecture & Development

```bash
# Watch mode for rapid development & hot reload
npm run dev

# Full production bundle & minify
npm run build

# TypeScript strict type checking
npm run typecheck
```

---

## 📄 License & Provenance

MIT License © 2026 GitOrbit Contributors.  
Derived and improved from upstream `github-valut-sync` by Livan Kumar (MIT License), integrating crucial community patches by `@teamsuperpanda` and `@JiaPeng1234`.

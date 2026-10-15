import { Plugin, Notice, TFile, TAbstractFile, Platform } from "obsidian";
import { GitVaultSyncSettings, DEFAULT_SETTINGS, SyncStatus, ConflictFile, ISyncEngine } from "./types";
import { GitOrbitSettingsTab } from "./ui/settings-tab";
import { StatusBarItem } from "./ui/status-bar";
import { ConflictModal } from "./ui/conflict-modal";
import { GitSync } from "./sync/git-sync";
import { GitHubApiSync } from "./sync/github-api-sync";
import { SyncQueue } from "./sync/queue";
import {
  repoExists,
  createRepo,
  vaultNameToRepoName,
  parseGitHubRepo,
  formatRemoteUrl,
} from "./github/api";

export default class GitOrbitPlugin extends Plugin {
  settings!: GitVaultSyncSettings;
  private statusBar!: StatusBarItem;
  private engine: ISyncEngine | null = null;
  private syncQueue: SyncQueue | null = null;
  private periodicTimer: number | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    // 1. Status Bar Setup
    this.statusBar = new StatusBarItem(this);
    this.statusBar.onClick(() => this.triggerManualSync(false));

    // 2. Settings Tab
    this.addSettingTab(new GitOrbitSettingsTab(this.app, this));

    // 3. User Commands
    this.addCommand({
      id: "sync-now",
      name: "Sync vault now",
      callback: () => this.triggerManualSync(false),
    });

    this.addCommand({
      id: "gitorbit-repair",
      name: "Repair and clean repository",
      callback: () => this.repairRepository(),
    });

    // 4. Boot engine if credentials exist
    if (
      this.settings.githubToken &&
      this.settings.githubUsername &&
      (this.settings.repoName || this.settings.remoteUrl)
    ) {
      await this.bootSyncEngine();
    }

    // 5. Pull on workspace ready (if syncOnStartup enabled)
    this.app.workspace.onLayoutReady(async () => {
      if (this.settings.syncOnStartup && this.engine) {
        this.setStatus("pulling");
        try {
          const conflicts = await this.engine.pull();
          if (conflicts && conflicts.length > 0) {
            this.setStatus("conflict", `${conflicts.length} conflict(s)`);
            this.showConflictModal(conflicts);
          } else {
            this.setStatus("idle");
          }
        } catch {
          this.setStatus("error", "Pull failed on startup");
        }
      }
    });

    // 6. Watch vault events for auto-sync (if autoSync enabled)
    this.registerEvent(
      this.app.vault.on("modify", (file: TAbstractFile) => {
        if (!(file instanceof TFile)) return;
        if (!this.syncQueue || !this.settings.autoSync) return;
        if (this.isExcluded(file.path)) return;
        this.syncQueue.enqueue(file.path);
      })
    );

    this.registerEvent(
      this.app.vault.on("create", (file: TAbstractFile) => {
        if (!(file instanceof TFile)) return;
        if (!this.syncQueue || !this.settings.autoSync) return;
        if (this.isExcluded(file.path)) return;
        this.syncQueue.enqueue(file.path);
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", (file: TAbstractFile) => {
        if (!(file instanceof TFile)) return;
        if (!this.syncQueue || !this.settings.autoSync) return;
        this.syncQueue.enqueue(file.path);
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", (_file: TAbstractFile, oldPath: string) => {
        if (!this.syncQueue || !this.settings.autoSync) return;
        this.syncQueue.enqueue(oldPath);
      })
    );
  }

  async onunload(): Promise<void> {
    // Teardown periodic timer
    if (this.periodicTimer !== null) {
      window.clearInterval(this.periodicTimer);
      this.periodicTimer = null;
    }

    // Zero-leak teardown: flush pending queue and destroy resources
    if (this.syncQueue) {
      await this.syncQueue.flushNow();
      this.syncQueue.destroy();
      this.syncQueue = null;
    }
    if (this.statusBar) {
      this.statusBar.destroy();
    }
    this.engine = null;
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    // Auto-derive remoteUrl if missing but username and repoName exist
    if (!this.settings.remoteUrl && this.settings.githubUsername && this.settings.repoName) {
      this.settings.remoteUrl = formatRemoteUrl(this.settings.githubUsername, this.settings.repoName);
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  setStatus(status: SyncStatus, detail?: string): void {
    this.statusBar.set(status, detail);
  }

  /**
   * Evaluates the effective engine:
   * "auto" defaults to "api" (GitHub Git Data API) on mobile and "git" (isomorphic-git) on desktop.
   */
  effectiveEngine(): "git" | "api" {
    if (this.settings.syncEngine === "auto") {
      return Platform.isMobile ? "api" : "git";
    }
    return this.settings.syncEngine;
  }

  /**
   * Initializes or links the remote GitHub repository for this vault.
   */
  async initializeRepo(
    token: string,
    username: string,
    targetRepoName?: string,
    customRemoteUrl?: string
  ): Promise<void> {
    this.setStatus("connecting");

    let repoName = targetRepoName?.trim() || "";
    let finalOwner = username;

    if (customRemoteUrl?.trim()) {
      const parsed = parseGitHubRepo(customRemoteUrl);
      if (parsed) {
        finalOwner = parsed.owner;
        repoName = parsed.repo;
        this.settings.remoteUrl = customRemoteUrl.trim();
      }
    }

    if (!repoName) {
      const vaultName = this.app.vault.getName();
      repoName = vaultNameToRepoName(vaultName);
    }

    this.settings.repoName = repoName;
    this.settings.githubUsername = finalOwner;
    if (!this.settings.remoteUrl) {
      this.settings.remoteUrl = formatRemoteUrl(finalOwner, repoName);
    }

    const exists = await repoExists(token, finalOwner, repoName);
    if (!exists) {
      await createRepo(token, repoName, `Obsidian Vault: ${this.app.vault.getName()}`);
      new Notice(`GitOrbit: Created private repo ${finalOwner}/${repoName}`);
    }

    const allFiles = () =>
      this.app.vault
        .getFiles()
        .map((f) => f.path)
        .filter((p) => !this.isExcluded(p));

    if (this.effectiveEngine() === "api") {
      const apiEngine = new GitHubApiSync(
        this.app.vault,
        token,
        finalOwner,
        repoName,
        this.settings.branch || "main",
        () => this.settings,
        () => this.saveSettings(),
        (msg) => this.setStatus("pushing", msg)
      );
      this.engine = apiEngine;

      const isInit = await apiEngine.isInitialized();
      if (!isInit) {
        await apiEngine.initAndPush(allFiles());
        new Notice(`GitOrbit: Initialized repo ${finalOwner}/${repoName} via GitHub API.`);
      } else {
        const conflicts = await apiEngine.pull();
        if (conflicts && conflicts.length > 0) {
          this.setStatus("conflict", `${conflicts.length} conflict(s)`);
          this.showConflictModal(conflicts);
        }
        new Notice(`GitOrbit: Linked & synced with ${finalOwner}/${repoName}`);
      }
    } else {
      const adapter = this.app.vault.adapter;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const vaultPath: string = (adapter as any).basePath ?? "";

      const sync = new GitSync(
        adapter,
        vaultPath,
        token,
        finalOwner,
        repoName,
        this.settings.authorName,
        this.settings.authorEmail,
        this.settings.remoteUrl
      );
      this.engine = sync;

      const alreadyInit = await sync.isInitialized();
      if (!exists || !alreadyInit) {
        if (exists) {
          const cloneHadCommits = await sync.clone();
          if (!cloneHadCommits) {
            await sync.initAndPush(allFiles());
            new Notice(`GitOrbit: Initialized repo ${finalOwner}/${repoName}`);
          } else {
            new Notice(`GitOrbit: Cloned repo ${finalOwner}/${repoName}`);
          }
        } else {
          await sync.initAndPush(allFiles());
          new Notice(`GitOrbit: Initialized repo ${finalOwner}/${repoName}`);
        }
      } else {
        try {
          const conflicts = await sync.pull();
          if (conflicts && conflicts.length > 0) {
            this.setStatus("conflict", `${conflicts.length} conflict(s)`);
            this.showConflictModal(conflicts);
          }
        } catch (err) {
          console.warn("GitOrbit: Initial pull warning:", err);
        }
        new Notice(`GitOrbit: Linked & synced with ${finalOwner}/${repoName}`);
      }
    }

    this.settings.lastSyncTime = Date.now();
    await this.saveSettings();
    await this.bootSyncEngine();
    this.setStatus("idle");
  }

  async bootSyncEngine(): Promise<void> {
    const { githubToken, githubUsername, repoName, remoteUrl, branch, authorName, authorEmail, syncIntervalMs } =
      this.settings;
    if (!githubToken || (!repoName && !remoteUrl)) return;

    let targetOwner = githubUsername;
    let targetRepo = repoName;

    if (remoteUrl) {
      const parsed = parseGitHubRepo(remoteUrl);
      if (parsed) {
        targetOwner = parsed.owner;
        targetRepo = parsed.repo;
      }
    }

    const targetBranch = branch || "main";

    if (this.effectiveEngine() === "api") {
      this.engine = new GitHubApiSync(
        this.app.vault,
        githubToken,
        targetOwner,
        targetRepo,
        targetBranch,
        () => this.settings,
        () => this.saveSettings(),
        (msg) => this.setStatus("pushing", msg)
      );
    } else {
      const adapter = this.app.vault.adapter;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const vaultPath: string = (adapter as any).basePath ?? "";

      this.engine = new GitSync(
        adapter,
        vaultPath,
        githubToken,
        targetOwner,
        targetRepo,
        authorName,
        authorEmail,
        remoteUrl
      );
    }

    const engine = this.engine;
    if (!engine) return;

    if (this.syncQueue) {
      this.syncQueue.setEngine(engine);
      this.syncQueue.setDebounceMs(syncIntervalMs);
    } else {
      this.syncQueue = new SyncQueue(
        engine,
        (status, detail) => {
          this.setStatus(status, detail);
          if (status === "idle") {
            this.settings.lastSyncTime = Date.now();
            this.saveSettings();
          }
        },
        (conflicts) => {
          this.setStatus("conflict", `${conflicts.length} conflict(s)`);
          this.showConflictModal(conflicts);
        },
        syncIntervalMs
      );
    }

    // Configure periodic sync timer
    this.restartPeriodicSync();
  }

  restartPeriodicSync(): void {
    if (this.periodicTimer !== null) {
      window.clearInterval(this.periodicTimer);
      this.periodicTimer = null;
    }

    if (this.settings.periodicSync && this.settings.periodicSyncMinutes > 0) {
      const ms = Math.max(1, this.settings.periodicSyncMinutes) * 60 * 1000;
      this.periodicTimer = window.setInterval(async () => {
        if (this.engine) {
          try {
            await this.triggerManualSync(true);
          } catch (err) {
            console.warn("GitOrbit: Periodic sync warning:", err);
          }
        }
      }, ms);
      this.registerInterval(this.periodicTimer);
    }
  }

  async triggerManualSync(silent = false): Promise<void> {
    if (!this.engine) {
      if (!silent) {
        new Notice("GitOrbit: Not connected. Please connect your GitHub account in settings.");
      }
      return;
    }

    this.setStatus("pulling");
    try {
      const allFiles = this.app.vault
        .getFiles()
        .map((f) => f.path)
        .filter((p) => !this.isExcluded(p));

      const result = await this.engine.sync(allFiles);

      if (result.conflictFiles.length > 0) {
        this.setStatus("conflict", `${result.conflictFiles.length} conflict(s)`);
        this.showConflictModal(result.conflictFiles);
      } else if (result.success) {
        this.settings.lastSyncTime = Date.now();
        await this.saveSettings();
        this.setStatus("idle");
        if (!silent) {
          new Notice("GitOrbit: Vault synced successfully.");
        }
      } else {
        this.setStatus("error", result.error);
        if (!silent) {
          new Notice(`GitOrbit: Sync error: ${result.error}`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.setStatus("error", msg);
      if (!silent) {
        new Notice(`GitOrbit: Sync failed: ${msg}`);
      }
    }
  }

  async repairRepository(): Promise<void> {
    if (!this.engine) {
      new Notice("GitOrbit: Not connected. Please connect in GitOrbit settings first.");
      return;
    }
    this.setStatus("connecting", "Repairing...");
    const result = this.engine.repairGitRepository
      ? await this.engine.repairGitRepository()
      : { cleanedCount: 0, errors: [] };
    this.setStatus("idle");
    if (result.cleanedCount > 0) {
      new Notice(`GitOrbit: Repaired repository. Cleaned ${result.cleanedCount} item(s).`);
    } else {
      new Notice("GitOrbit: Repository check passed. Zero corrupted objects found.");
    }
  }

  private showConflictModal(conflicts: ConflictFile[]): void {
    new ConflictModal(
      this.app,
      conflicts,
      async (filepath, resolved) => {
        await this.engine!.resolveConflict(filepath, resolved);
        this.settings.lastSyncTime = Date.now();
        await this.saveSettings();
        this.setStatus("idle");
        new Notice(`GitOrbit: Conflict resolved for ${filepath}`);
      }
    ).open();
  }

  private isExcluded(filepath: string): boolean {
    return this.settings.excludePatterns.some((pattern) => {
      const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      const regexStr = escaped.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*");
      return new RegExp(`^${regexStr}$`).test(filepath);
    });
  }
}

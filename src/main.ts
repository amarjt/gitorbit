import { Plugin, Notice, TFile, TAbstractFile } from "obsidian";
import { GitVaultSyncSettings, DEFAULT_SETTINGS, SyncStatus, ConflictFile } from "./types";
import { GitOrbitSettingsTab } from "./ui/settings-tab";
import { StatusBarItem } from "./ui/status-bar";
import { ConflictModal } from "./ui/conflict-modal";
import { GitSync } from "./sync/git-sync";
import { SyncQueue } from "./sync/queue";
import { repoExists, createRepo, vaultNameToRepoName } from "./github/api";

export default class GitOrbitPlugin extends Plugin {
  settings!: GitVaultSyncSettings;
  private statusBar!: StatusBarItem;
  private gitSync: GitSync | null = null;
  private syncQueue: SyncQueue | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    // 1. Status Bar Setup
    this.statusBar = new StatusBarItem(this);
    this.statusBar.onClick(() => this.triggerManualSync());

    // 2. Settings Tab
    this.addSettingTab(new GitOrbitSettingsTab(this.app, this));

    // 3. User Commands
    this.addCommand({
      id: "sync-now",
      name: "Sync vault now",
      callback: () => this.triggerManualSync(),
    });

    this.addCommand({
      id: "gitorbit-repair",
      name: "Repair and clean local git repository",
      callback: () => this.repairRepository(),
    });

    // 4. Boot engine if already configured
    if (
      this.settings.githubToken &&
      this.settings.githubUsername &&
      this.settings.repoName
    ) {
      await this.bootSyncEngine();
    }

    // 5. Pull on workspace ready
    this.app.workspace.onLayoutReady(async () => {
      if (this.gitSync) {
        this.setStatus("pulling");
        try {
          const conflicts = await this.gitSync.pull();
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

    // 6. Watch vault events for auto-sync
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
    // Zero-leak teardown: flush pending queue and destroy resources
    if (this.syncQueue) {
      await this.syncQueue.flushNow();
      this.syncQueue.destroy();
      this.syncQueue = null;
    }
    if (this.statusBar) {
      this.statusBar.destroy();
    }
    this.gitSync = null;
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  setStatus(status: SyncStatus, detail?: string): void {
    this.statusBar.set(status, detail);
  }

  /**
   * Initializes or links the remote GitHub repository for this vault.
   */
  async initializeRepo(token: string, username: string): Promise<void> {
    this.setStatus("connecting");

    const vaultName = this.app.vault.getName();
    const repoName = vaultNameToRepoName(vaultName);
    this.settings.repoName = repoName;

    const adapter = this.app.vault.adapter;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vaultPath: string = (adapter as any).basePath ?? "";

    const sync = new GitSync(
      adapter,
      vaultPath,
      token,
      username,
      repoName,
      this.settings.authorName,
      this.settings.authorEmail
    );

    const exists = await repoExists(token, username, repoName);
    const alreadyInit = await sync.isInitialized();

    const allFiles = () =>
      this.app.vault
        .getFiles()
        .map((f) => f.path)
        .filter((p) => !this.isExcluded(p));

    if (!exists) {
      await createRepo(token, repoName, `Obsidian Vault: ${vaultName}`);
      await sync.initAndPush(allFiles());
      new Notice(`GitOrbit: Created private repo ${username}/${repoName}`);
    } else if (!alreadyInit) {
      const cloneHadCommits = await sync.clone();
      if (!cloneHadCommits) {
        await sync.initAndPush(allFiles());
        new Notice(`GitOrbit: Initialized repo ${username}/${repoName}`);
      } else {
        new Notice(`GitOrbit: Cloned repo ${username}/${repoName}`);
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
      new Notice(`GitOrbit: Linked & synced with ${username}/${repoName}`);
    }

    this.settings.lastSyncTime = Date.now();
    await this.saveSettings();
    await this.bootSyncEngine();
    this.setStatus("idle");
  }

  async bootSyncEngine(): Promise<void> {
    const { githubToken, githubUsername, repoName, authorName, authorEmail, syncIntervalMs } = this.settings;
    if (!githubToken || !githubUsername || !repoName) return;

    const adapter = this.app.vault.adapter;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vaultPath: string = (adapter as any).basePath ?? "";

    this.gitSync = new GitSync(
      adapter,
      vaultPath,
      githubToken,
      githubUsername,
      repoName,
      authorName,
      authorEmail
    );

    this.syncQueue = new SyncQueue(
      this.gitSync,
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

  async triggerManualSync(): Promise<void> {
    if (!this.gitSync) {
      new Notice("GitOrbit: Not connected. Please connect your GitHub account in settings.");
      return;
    }

    this.setStatus("pulling");
    try {
      const allFiles = this.app.vault
        .getFiles()
        .map((f) => f.path)
        .filter((p) => !this.isExcluded(p));

      const result = await this.gitSync.sync(allFiles);

      if (result.conflictFiles.length > 0) {
        this.setStatus("conflict", `${result.conflictFiles.length} conflict(s)`);
        this.showConflictModal(result.conflictFiles);
      } else if (result.success) {
        this.settings.lastSyncTime = Date.now();
        await this.saveSettings();
        this.setStatus("idle");
        new Notice("GitOrbit: Vault synced successfully.");
      } else {
        this.setStatus("error", result.error);
        new Notice(`GitOrbit: Sync error: ${result.error}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.setStatus("error", msg);
      new Notice(`GitOrbit: Sync failed: ${msg}`);
    }
  }

  async repairRepository(): Promise<void> {
    if (!this.gitSync) {
      new Notice("GitOrbit: Not connected. Please connect in GitOrbit settings first.");
      return;
    }
    this.setStatus("connecting", "Repairing...");
    const result = await this.gitSync.repairGitRepository();
    this.setStatus("idle");
    if (result.cleanedCount > 0) {
      new Notice(`GitOrbit: Repaired repository. Cleaned ${result.cleanedCount} corrupted/stale item(s).`);
    } else {
      new Notice("GitOrbit: Repository check passed. Zero corrupted objects found.");
    }
  }

  private showConflictModal(conflicts: ConflictFile[]): void {
    new ConflictModal(
      this.app,
      conflicts,
      async (filepath, resolved) => {
        await this.gitSync!.resolveConflict(filepath, resolved);
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

import {
  App,
  ButtonComponent,
  DropdownComponent,
  Notice,
  PluginSettingTab,
  Setting,
  TextComponent,
} from "obsidian";
import type GitOrbitPlugin from "../main";
import { requestDeviceCode, pollForToken } from "../auth/github-device";
import {
  getAuthenticatedUser,
  fetchUserRepos,
  parseGitHubRepo,
  formatRemoteUrl,
  remoteUrlHint,
  fetchRemoteBranches,
  createRemoteBranch,
  isValidBranchName,
} from "../github/api";
import { DEFAULT_CLIENT_ID } from "../constants";
import { GitHubRepo } from "../types";

const NEW_BRANCH = "__gitorbit_new_branch__";
const REMOTE_MANUAL = "__gitorbit_remote_manual__";
const CREATE_NEW_REPO_VAL = "__gitorbit_new_repo__";

export class GitOrbitSettingsTab extends PluginSettingTab {
  plugin: GitOrbitPlugin;
  private userRepos: GitHubRepo[] = [];
  private reposFetched = false;
  private remoteBranches: string[] = [];
  private branchesFetched = false;
  private creatingBranch = false;
  private createBranchBase = "main";
  private remoteManual = false;

  constructor(app: App, plugin: GitOrbitPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    // Preserve scroll position across re-renders (ObsSync pattern)
    const scroller = this.scrollContainer();
    const prevScroll = scroller?.scrollTop ?? 0;

    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("gitorbit-settings");

    const settings = this.plugin.settings;
    const hasCreds = Boolean(settings.githubToken && (settings.remoteUrl || settings.repoName));

    // Auto-fetch remote branches on first open when credentials exist
    if (hasCreds && !this.branchesFetched) {
      this.branchesFetched = true;
      void this.fetchBranches(true);
    }

    // ── 0. Top-Level "Sync Now" CTA Banner (ObsSync Pattern) ───────────────────
    if (hasCreds) {
      new Setting(containerEl)
        .setName("Sync now")
        .setDesc("Pull remote updates and push all pending local changes immediately.")
        .addButton((btn) => {
          btn.setButtonText("Sync Now").setCta();
          btn.onClick(async () => {
            btn.setDisabled(true).setButtonText("Syncing…");
            try {
              await this.plugin.triggerManualSync(false);
            } finally {
              btn.setDisabled(false).setButtonText("Sync Now");
            }
          });
        });
    }

    // ── 1. Authentication Section ────────────────────────────────────────────
    new Setting(containerEl).setName("GitHub Authentication").setHeading();

    if (settings.githubToken && settings.githubUsername) {
      // Connected State Row
      new Setting(containerEl)
        .setName("Connected account")
        .setDesc(
          `Signed in as @${settings.githubUsername} (${
            settings.authType === "pat" ? "Personal Access Token" : "OAuth Device Flow"
          })`
        )
        .addButton((btn) =>
          btn
            .setButtonText("Disconnect")
            .setWarning()
            .onClick(async () => {
              settings.githubToken = "";
              settings.githubUsername = "";
              settings.repoName = "";
              settings.remoteUrl = "";
              this.userRepos = [];
              this.reposFetched = false;
              this.remoteBranches = [];
              this.branchesFetched = false;
              await this.plugin.saveSettings();
              new Notice("GitOrbit: Disconnected from GitHub.");
              this.display();
            })
        );
    } else {
      // Disconnected State: Auth Method Chooser
      new Setting(containerEl)
        .setName("Authentication method")
        .setDesc("Choose between Personal Access Token (PAT) or Browser Login (OAuth Device Flow).")
        .addDropdown((drop) =>
          drop
            .addOption("pat", "Personal Access Token (PAT) — Recommended")
            .addOption("oauth", "Browser Login (OAuth Device Flow)")
            .setValue(settings.authType || "pat")
            .onChange(async (val) => {
              settings.authType = val as "pat" | "oauth";
              await this.plugin.saveSettings();
              this.display();
            })
        );

      if (settings.authType === "oauth") {
        // OAuth Device Flow UI
        new Setting(containerEl)
          .setName("Connect with GitHub")
          .setDesc("Opens github.com/login/device in your browser. Enter the 8-character code displayed below.")
          .addButton((btn) => {
            btn
              .setButtonText("Connect via Browser")
              .setCta()
              .onClick(async () => {
                await this.startDeviceFlow(btn);
              });
          });

        new Setting(containerEl)
          .setName("OAuth Client ID (Optional)")
          .setDesc("Leave as default unless using your own registered GitHub OAuth application.")
          .addText((text) =>
            text
              .setPlaceholder(DEFAULT_CLIENT_ID)
              .setValue(settings.clientId)
              .onChange(async (val) => {
                settings.clientId = val.trim() || DEFAULT_CLIENT_ID;
                await this.plugin.saveSettings();
              })
          );
      } else {
        // Personal Access Token UI (ObsSync Single-Row with Live Authorize Button)
        let authBtnSetDisabled: ((disabled: boolean) => void) | null = null;
        let tokenVal = settings.githubToken;

        const tokenSetting = new Setting(containerEl)
          .setName("Personal Access Token")
          .setDesc("Generate a GitHub token with 'repo' scope enabled at github.com/settings/tokens.")
          .addText((text) => {
            text.inputEl.type = "password";
            text.inputEl.addClass("gitorbit-token-input");
            text
              .setPlaceholder("ghp_xxxxxxxxxxxxxxxxxxxx")
              .setValue(settings.githubToken)
              .onChange(async (val) => {
                tokenVal = val.trim();
                authBtnSetDisabled?.(!tokenVal);
              });
          });

        tokenSetting.addButton((btn) => {
          btn.setButtonText("Authorize").setCta();
          btn.setDisabled(!tokenVal);
          authBtnSetDisabled = (d) => btn.setDisabled(d);

          btn.onClick(async () => {
            if (!tokenVal) return;
            btn.setDisabled(true).setButtonText("Authorizing…");
            try {
              const user = await getAuthenticatedUser(tokenVal);
              settings.githubToken = tokenVal;
              settings.githubUsername = user.login;
              if (!settings.authorName) settings.authorName = user.name || user.login;
              if (user.email && !settings.authorEmail) settings.authorEmail = user.email;

              // Fetch repos immediately
              this.userRepos = await fetchUserRepos(tokenVal);
              this.reposFetched = true;
              this.remoteManual = !this.userRepos.some(
                (r) => r.clone_url === settings.remoteUrl || r.full_name === `${settings.githubUsername}/${settings.repoName}`
              );

              // Auto-initialize if no repo set yet
              if (!settings.repoName) {
                await this.plugin.initializeRepo(tokenVal, user.login);
              }

              await this.plugin.saveSettings();
              new Notice(`GitOrbit: Authorized as @${user.login} (${this.userRepos.length} repos accessible)`);
              this.display();
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              console.error("GitOrbit: Authorization failed:", err);
              new Notice(`GitOrbit: Authorization failed: ${msg}`);
              btn.setDisabled(false).setButtonText("Authorize");
            }
          });
        });
      }
    }

    // ── 2. Repository & Branch Configuration (ObsSync Pattern) ────────────────
    new Setting(containerEl).setName("Repository & Remote URL").setHeading();

    this.renderRemoteSetting(containerEl);
    this.renderBranchSetting(containerEl);

    // ── 3. Automatic Synchronization Suite (ObsSync Pattern) ──────────────────
    new Setting(containerEl).setName("Automatic Synchronization").setHeading();

    // 3.1 Sync on Startup
    new Setting(containerEl)
      .setName("Sync on startup")
      .setDesc("Automatically pull and merge the latest changes from GitHub when Obsidian loads.")
      .addToggle((toggle) =>
        toggle.setValue(settings.syncOnStartup).onChange(async (val) => {
          settings.syncOnStartup = val;
          await this.plugin.saveSettings();
        })
      );

    // 3.2 Sync on File Edits
    new Setting(containerEl)
      .setName("Sync on file edits")
      .setDesc("Automatically commit and push changes after editing vault notes.")
      .addToggle((toggle) =>
        toggle.setValue(settings.autoSync).onChange(async (val) => {
          settings.autoSync = val;
          await this.plugin.saveSettings();
        })
      );

    // 3.3 Debounce Slider
    new Setting(containerEl)
      .setName("Sync debounce (ms)")
      .setDesc("Wait time in milliseconds after the last file edit before pushing.")
      .addSlider((slider) =>
        slider
          .setLimits(1000, 10000, 500)
          .setValue(settings.syncIntervalMs)
          .setDynamicTooltip()
          .onChange(async (val) => {
            settings.syncIntervalMs = val;
            await this.plugin.saveSettings();
            await this.plugin.bootSyncEngine();
          })
      );

    // 3.4 Periodic Background Sync (Toggle & Smoothly Hidden Interval Input)
    let intervalEl: HTMLElement | null = null;

    new Setting(containerEl)
      .setName("Periodic background sync")
      .setDesc("Periodically check for remote updates and push local notes on a recurring timer.")
      .addToggle((toggle) =>
        toggle.setValue(settings.periodicSync).onChange(async (val) => {
          settings.periodicSync = val;
          await this.plugin.saveSettings();
          this.plugin.restartPeriodicSync();
          intervalEl?.toggleClass("gitorbit-hidden", !val);
        })
      );

    const intervalSetting = new Setting(containerEl)
      .setName("Periodic sync interval")
      .setDesc("Interval between automated background sync checks.")
      .addDropdown((drop) =>
        drop
          .addOption("2", "Every 2 minutes")
          .addOption("5", "Every 5 minutes")
          .addOption("10", "Every 10 minutes")
          .addOption("15", "Every 15 minutes")
          .addOption("30", "Every 30 minutes")
          .addOption("60", "Every 60 minutes")
          .setValue(String(settings.periodicSyncMinutes || 10))
          .onChange(async (val) => {
            settings.periodicSyncMinutes = parseInt(val, 10) || 10;
            await this.plugin.saveSettings();
            this.plugin.restartPeriodicSync();
          })
      );
    intervalEl = intervalSetting.settingEl;
    intervalEl.toggleClass("gitorbit-hidden", !settings.periodicSync);

    // ── 4. Git Commit Identity & Message ─────────────────────────────────────
    new Setting(containerEl).setName("Commit Identity & Message").setHeading();

    new Setting(containerEl)
      .setName("Author Name")
      .setDesc("Git author name attached to automated sync commits.")
      .addText((text) =>
        text
          .setPlaceholder("GitOrbit")
          .setValue(settings.authorName)
          .onChange(async (val) => {
            settings.authorName = val.trim() || "GitOrbit";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Author Email")
      .setDesc("Git author email attached to automated sync commits.")
      .addText((text) =>
        text
          .setPlaceholder("sync@gitorbit.local")
          .setValue(settings.authorEmail)
          .onChange(async (val) => {
            settings.authorEmail = val.trim() || "sync@gitorbit.local";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Commit message template")
      .setDesc("Template for automated sync commits. Supports {{datetime}} (ISO timestamp) and {{date}} (YYYY-MM-DD).")
      .addText((text) =>
        text
          .setPlaceholder("sync: {{datetime}}")
          .setValue(settings.commitMessageTemplate || "sync: {{datetime}}")
          .onChange(async (val) => {
            settings.commitMessageTemplate = val.trim() || "sync: {{datetime}}";
            await this.plugin.saveSettings();
          })
      );

    // ── 5. Sync Engine & Vault Exclusions ────────────────────────────────────
    new Setting(containerEl).setName("Sync Engine & Exclusions").setHeading();

    const currentEngine = this.plugin.effectiveEngine();
    new Setting(containerEl)
      .setName("Sync Engine")
      .setDesc(
        `Active: ${
          currentEngine === "api"
            ? "GitHub Git Data API (Mobile Optimized, zero-packfile, immune to buffer decompression errors)"
            : "Git Engine (isomorphic-git, full local git history)"
        }. Auto selects Git on Desktop and GitHub API on Mobile.`
      )
      .addDropdown((drop) =>
        drop
          .addOption("auto", "Auto (Desktop: Git, Mobile: GitHub API)")
          .addOption("git", "Git Engine (isomorphic-git)")
          .addOption("api", "GitHub API Engine (Git Data API)")
          .setValue(settings.syncEngine)
          .onChange(async (val) => {
            settings.syncEngine = val as "auto" | "git" | "api";
            await this.plugin.saveSettings();
            await this.plugin.bootSyncEngine();
            this.display();
          })
      );

    // Stacked Full-Width Excluded Patterns Textarea (ObsSync Pattern)
    const excludeSetting = new Setting(containerEl)
      .setName("Excluded patterns")
      .setDesc("One glob pattern per line. Matching files will be completely excluded from git sync.")
      .addTextArea((ta) => {
        ta.setValue(settings.excludePatterns.join("\n")).onChange(async (val) => {
          settings.excludePatterns = val
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean);
          await this.plugin.saveSettings();
        });
        ta.inputEl.rows = 8;
        ta.inputEl.addClass("gitorbit-exclude-textarea");
      });
    excludeSetting.settingEl.addClass("gitorbit-setting-stacked");

    containerEl.createEl("div", {
      text: "Note: Excluded files will never be committed or pushed. On mobile (API engine), configuration and workspace folders are automatically excluded to preserve device stability.",
      cls: "gitorbit-setting-hint",
    });

    // ── 6. Maintenance & Diagnostics ─────────────────────────────────────────
    new Setting(containerEl).setName("Maintenance & Diagnostics").setHeading();

    new Setting(containerEl)
      .setName("Repair & clean repository")
      .setDesc("Scans for and purges corrupted 0-byte objects, orphan pack indexes, and resets baseline snapshots.")
      .addButton((btn) =>
        btn.setButtonText("Repair Repository").onClick(async () => {
          btn.setButtonText("Repairing…").setDisabled(true);
          await this.plugin.repairRepository();
          btn.setButtonText("Repair Repository").setDisabled(false);
        })
      );

    if (settings.lastSyncTime > 0) {
      const lastSync = new Date(settings.lastSyncTime).toLocaleString();
      containerEl.createEl("p", {
        text: `Last synced: ${lastSync}`,
        cls: "setting-item-description",
      });
    }

    // Restore scroll position
    if (scroller) {
      scroller.scrollTop = prevScroll;
    }
  }

  /**
   * Nearest scrollable ancestor container (ObsSync pattern)
   */
  private scrollContainer(): HTMLElement | null {
    let el: HTMLElement | null = this.containerEl;
    while (el) {
      const overflowY = getComputedStyle(el).overflowY;
      if (
        (overflowY === "auto" || overflowY === "scroll") &&
        el.scrollHeight > el.clientHeight
      ) {
        return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  /**
   * Remote URL Chooser (ObsSync Pattern):
   * When repositories are fetched, shows a dropdown with private/public indicators,
   * "+ Create new private repo", and "Enter custom remote URL...".
   * Toggling custom mode reveals the manual input smoothly without scroll jump.
   */
  private renderRemoteSetting(containerEl: HTMLElement): void {
    const s = this.plugin.settings;
    const hasRepos = this.userRepos.length > 0;
    const currentFull = s.repoName ? `${s.githubUsername}/${s.repoName}` : "";

    const matchesRepo = this.userRepos.some(
      (r) => r.clone_url === s.remoteUrl || r.full_name === currentFull
    );
    const showManual = hasRepos ? this.remoteManual || !matchesRepo : true;

    let manualEl: HTMLElement | null = null;
    let manualText: TextComponent | null = null;
    let updateRemoteHint = () => {};

    if (hasRepos) {
      new Setting(containerEl)
        .setName("GitHub Repository")
        .setDesc("Select an existing repository from your account, create a new private repo, or enter a custom clone URL.")
        .addDropdown((dd: DropdownComponent) => {
          if (currentFull && !this.userRepos.some((r) => r.full_name === currentFull)) {
            dd.addOption(currentFull, currentFull);
          }

          for (const r of this.userRepos) {
            const label = r.private ? `🔒 ${r.full_name}` : `📄 ${r.full_name}`;
            dd.addOption(r.clone_url || r.full_name, label);
          }

          dd.addOption(CREATE_NEW_REPO_VAL, "+ Create new private repository for this vault");
          dd.addOption(REMOTE_MANUAL, "✏️ Enter custom remote URL…");

          const selectedVal = showManual ? REMOTE_MANUAL : (s.remoteUrl || currentFull);
          dd.setValue(selectedVal);

          dd.onChange(async (val) => {
            if (val === REMOTE_MANUAL) {
              this.remoteManual = true;
              manualEl?.toggleClass("gitorbit-hidden", false);
              manualText?.inputEl.focus();
              return;
            }

            if (val === CREATE_NEW_REPO_VAL) {
              this.remoteManual = false;
              manualEl?.toggleClass("gitorbit-hidden", true);
              await this.plugin.initializeRepo(s.githubToken, s.githubUsername);
              this.display();
              return;
            }

            this.remoteManual = false;
            manualEl?.toggleClass("gitorbit-hidden", true);

            const parsed = parseGitHubRepo(val);
            if (parsed) {
              s.githubUsername = parsed.owner;
              s.repoName = parsed.repo;
              s.remoteUrl = formatRemoteUrl(parsed.owner, parsed.repo);
            } else {
              s.remoteUrl = val;
            }

            this.branchesFetched = false;
            this.remoteBranches = [];
            await this.plugin.saveSettings();
            await this.plugin.bootSyncEngine();
            new Notice(`GitOrbit: Configured repository ${s.githubUsername}/${s.repoName}`);
          });
        })
        .addExtraButton((btn) =>
          btn
            .setIcon("refresh-cw")
            .setTooltip("Refresh repositories from GitHub")
            .onClick(async () => {
              btn.setDisabled(true);
              new Notice("GitOrbit: Refreshing repositories from GitHub…");
              await this.loadRepositories(true);
            })
        );
    }

    // Manual remote URL input
    const remoteSetting = new Setting(containerEl)
      .setName("Remote URL")
      .setDesc("HTTPS clone URL of the remote GitHub repository.")
      .addText((text) => {
        manualText = text;
        text
          .setPlaceholder("https://github.com/owner/repository.git")
          .setValue(s.remoteUrl || (s.repoName ? formatRemoteUrl(s.githubUsername, s.repoName) : ""))
          .onChange(async (val) => {
            const trimmed = val.trim();
            s.remoteUrl = trimmed;

            const parsed = parseGitHubRepo(trimmed);
            if (parsed) {
              s.githubUsername = parsed.owner;
              s.repoName = parsed.repo;
            }

            this.branchesFetched = false;
            this.remoteBranches = [];
            updateRemoteHint();
            await this.plugin.saveSettings();
            await this.plugin.bootSyncEngine();
          });
      });

    const remoteHint = remoteSetting.descEl.createDiv({
      cls: "gitorbit-setting-hint",
    });
    updateRemoteHint = () => {
      const hint = remoteUrlHint(s.remoteUrl);
      if (hint) {
        remoteHint.setText(`⚠️ ${hint}`);
        remoteHint.toggleClass("gitorbit-hidden", false);
      } else {
        remoteHint.setText("");
        remoteHint.toggleClass("gitorbit-hidden", true);
      }
    };
    updateRemoteHint();

    manualEl = remoteSetting.settingEl;
    manualEl.toggleClass("gitorbit-hidden", hasRepos && !showManual);

    // Lazily fetch repos if authenticated but not yet fetched
    if (s.githubToken && !this.reposFetched) {
      void this.loadRepositories(false);
    }
  }

  /**
   * Branch Chooser with Refresh and Inline "Create New Branch" (ObsSync Pattern)
   */
  private renderBranchSetting(containerEl: HTMLElement): void {
    const s = this.plugin.settings;
    const known = Array.from(
      new Set([s.branch || "main", ...this.remoteBranches].filter(Boolean))
    );

    new Setting(containerEl)
      .setName("Git Branch")
      .setDesc("Remote target branch for synchronizing commits.")
      .addDropdown((dd) => {
        for (const b of known) {
          dd.addOption(b, b);
        }
        dd.addOption(NEW_BRANCH, "+ Create new branch…");
        dd.setValue(s.branch || "main").onChange(async (value) => {
          if (value === NEW_BRANCH) {
            this.createBranchBase = s.branch || "main";
            this.creatingBranch = true;
            this.display();
            return;
          }
          s.branch = value;
          await this.plugin.saveSettings();
          await this.plugin.bootSyncEngine();
        });
      })
      .addExtraButton((btn) =>
        btn
          .setIcon("refresh-cw")
          .setTooltip("Refresh branches from remote")
          .onClick(() => void this.fetchBranches(false))
      );

    if (this.creatingBranch) {
      let newName = "";
      let createBtnSetDisabled: ((disabled: boolean) => void) | null = null;

      const newBranchSetting = new Setting(containerEl)
        .setName("New branch name")
        .setDesc(`Branching off from: ${this.createBranchBase}`)
        .addText((text) =>
          text
            .setPlaceholder("e.g. feature/mobile-sync")
            .onChange((val) => {
              newName = val.trim();
              if (!newName) {
                updateBranchError(null);
                createBtnSetDisabled?.(true);
                return;
              }
              if (!isValidBranchName(newName)) {
                updateBranchError("Invalid branch name. Must not contain spaces, control characters, or invalid git ref syntax.");
                createBtnSetDisabled?.(true);
                return;
              }
              updateBranchError(null);
              createBtnSetDisabled?.(false);
            })
        )
        .addButton((btn) => {
          btn.setButtonText("Create branch").setCta();
          btn.setDisabled(true);
          createBtnSetDisabled = (d) => btn.setDisabled(d);
          btn.onClick(() => void this.confirmCreateBranch(newName, btn));
        })
        .addExtraButton((btn) =>
          btn
            .setIcon("x")
            .setTooltip("Cancel")
            .onClick(() => {
              this.creatingBranch = false;
              this.display();
            })
        );

      const branchError = newBranchSetting.descEl.createDiv({
        cls: "gitorbit-setting-error",
      });
      const updateBranchError = (msg: string | null) => {
        branchError.setText(msg ?? "");
        branchError.toggleClass("gitorbit-hidden", !msg);
      };
      updateBranchError(null);
    }
  }

  /**
   * Create new remote branch off base branch via GitHub API (ObsSync Pattern)
   */
  private async confirmCreateBranch(
    newName: string,
    btn: ButtonComponent
  ): Promise<void> {
    const s = this.plugin.settings;
    const name = newName.trim();
    if (!name || !isValidBranchName(name)) return;

    if (!s.githubToken) {
      new Notice("GitOrbit: GitHub token required to create branches.");
      return;
    }

    const parsed = parseGitHubRepo(s.remoteUrl || `${s.githubUsername}/${s.repoName}`);
    if (!parsed) {
      new Notice("GitOrbit: A valid GitHub repository must be configured to create remote branches.");
      return;
    }

    const base = this.createBranchBase || "main";
    btn.setDisabled(true).setButtonText("Creating…");
    new Notice(`GitOrbit: Creating branch '${name}' from '${base}'…`);

    try {
      await createRemoteBranch(s.githubToken, parsed.owner, parsed.repo, name, base);
      s.branch = name;
      if (!this.remoteBranches.includes(name)) {
        this.remoteBranches.push(name);
      }
      await this.plugin.saveSettings();
      await this.plugin.bootSyncEngine();
      this.creatingBranch = false;
      new Notice(`GitOrbit: Successfully created and switched to branch '${name}'.`);
      this.display();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("GitOrbit: Failed to create branch:", err);
      new Notice(`GitOrbit: Branch creation failed: ${msg}`);
      btn.setDisabled(false).setButtonText("Create branch");
    }
  }

  /**
   * Fetch remote branches from GitHub
   */
  private async fetchBranches(silent: boolean): Promise<void> {
    const s = this.plugin.settings;
    if (!s.githubToken) return;

    const parsed = parseGitHubRepo(s.remoteUrl || `${s.githubUsername}/${s.repoName}`);
    if (!parsed) return;

    if (!silent) {
      new Notice("GitOrbit: Fetching remote branches…");
    }

    try {
      this.remoteBranches = await fetchRemoteBranches(s.githubToken, parsed.owner, parsed.repo);
      this.branchesFetched = true;
      if (!silent) {
        new Notice(`GitOrbit: Found ${this.remoteBranches.length} remote branch(es).`);
      }
      this.display();
    } catch (err) {
      console.warn("GitOrbit: Failed to fetch branches:", err);
      if (!silent) {
        new Notice("GitOrbit: Could not fetch branches from remote.");
      }
    }
  }

  /**
   * Load user repositories from GitHub
   */
  private async loadRepositories(forceNotice = false): Promise<void> {
    const token = this.plugin.settings.githubToken;
    if (!token) return;

    try {
      this.userRepos = await fetchUserRepos(token);
      this.reposFetched = true;
      if (forceNotice) {
        new Notice(`GitOrbit: Loaded ${this.userRepos.length} repository option(s).`);
      }
      this.display();
    } catch (err) {
      console.warn("GitOrbit: Failed to fetch repos:", err);
      if (forceNotice) {
        new Notice("GitOrbit: Could not fetch repositories from GitHub.");
      }
    }
  }

  /**
   * OAuth Device Flow (Browser Login)
   */
  private async startDeviceFlow(btn: ButtonComponent): Promise<void> {
    btn.setButtonText("Connecting…").setDisabled(true);

    try {
      const deviceFlow = await requestDeviceCode(this.plugin.settings.clientId);

      const modal = this.containerEl.createDiv({ cls: "gitorbit-device-modal" });
      modal.style.cssText =
        "background:var(--background-secondary);border-radius:8px;padding:16px;" +
        "margin-top:12px;text-align:center;border:1px solid var(--interactive-accent);";
      modal.createEl("p", {
        text: "Open this URL in your browser and enter the one-time code below:",
      });
      const link = modal.createEl("a", {
        text: deviceFlow.verification_uri,
        href: deviceFlow.verification_uri,
      });
      link.style.display = "block";
      const codeEl = modal.createEl("h1", {
        text: deviceFlow.user_code,
        cls: "gitorbit-user-code",
      });
      codeEl.style.cssText =
        "font-size:2rem;letter-spacing:0.25em;font-weight:700;" +
        "color:var(--text-normal);background:var(--background-primary);" +
        "border:2px solid var(--interactive-accent);border-radius:6px;" +
        "padding:8px 24px;display:inline-block;margin:12px auto;font-family:var(--font-monospace);";
      modal.createEl("p", {
        text: "Waiting for approval in browser…",
        cls: "setting-item-description",
      });

      btn.setButtonText("Cancel").setDisabled(false);

      window.open(deviceFlow.verification_uri, "_blank");

      const token = await pollForToken(
        deviceFlow.device_code,
        deviceFlow.interval,
        deviceFlow.expires_in,
        this.plugin.settings.clientId
      );

      modal.remove();

      const user = await getAuthenticatedUser(token);
      this.plugin.settings.githubToken = token;
      this.plugin.settings.githubUsername = user.login;
      if (!this.plugin.settings.authorName) {
        this.plugin.settings.authorName = user.name || user.login;
      }
      if (user.email && !this.plugin.settings.authorEmail) {
        this.plugin.settings.authorEmail = user.email;
      }

      await this.plugin.initializeRepo(token, user.login);
      await this.plugin.saveSettings();
      new Notice(`GitOrbit: Connected as @${user.login}! Vault sync active.`);
      this.display();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.containerEl.querySelector(".gitorbit-device-modal")?.remove();
      new Notice(`GitOrbit: Connection error: ${msg}`);
      btn.setButtonText("Connect via Browser").setDisabled(false);
    }
  }
}

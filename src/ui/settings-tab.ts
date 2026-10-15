import { App, PluginSettingTab, Setting, Notice, ButtonComponent } from "obsidian";
import type GitOrbitPlugin from "../main";
import { requestDeviceCode, pollForToken } from "../auth/github-device";
import {
  getAuthenticatedUser,
  fetchUserRepos,
  parseGitHubRepo,
  formatRemoteUrl,
  remoteUrlHint,
} from "../github/api";
import { DEFAULT_CLIENT_ID } from "../constants";
import { GitHubRepo } from "../types";

const CREATE_NEW_REPO_VAL = "__gitorbit_new_repo__";
const CUSTOM_REMOTE_VAL = "__gitorbit_custom_remote__";

export class GitOrbitSettingsTab extends PluginSettingTab {
  plugin: GitOrbitPlugin;
  private userRepos: GitHubRepo[] = [];
  private reposFetched = false;

  constructor(app: App, plugin: GitOrbitPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "GitOrbit Settings" });
    const settings = this.plugin.settings;

    // ── Authentication & Connection Section ──────────────────────────────────
    containerEl.createEl("h3", { text: "GitHub Connection & Repository" });

    if (settings.githubToken && settings.githubUsername) {
      // Connected State Banner
      const card = containerEl.createDiv({ cls: "gitorbit-connected-card" });
      card.style.cssText =
        "background:var(--background-secondary);padding:14px;border-radius:8px;" +
        "border:1px solid var(--interactive-accent);margin-bottom:14px;";

      card.createEl("div", {
        text: `Connected to GitHub as @${settings.githubUsername} (${
          settings.authType === "pat" ? "Personal Access Token" : "OAuth Device Flow"
        })`,
        cls: "setting-item-name",
      });

      card.createEl("div", {
        text: `Active Remote: ${settings.remoteUrl || formatRemoteUrl(settings.githubUsername, settings.repoName)}`,
        cls: "setting-item-description",
      });

      // ── Repository Chooser Dropdown ──
      const repoSetting = new Setting(containerEl)
        .setName("GitHub Repository")
        .setDesc("Select an existing GitHub repository from your account, create a new one, or enter a custom clone URL.")
        .addDropdown((drop) => {
          const currentFull = `${settings.githubUsername}/${settings.repoName}`;
          if (settings.repoName) {
            drop.addOption(currentFull, currentFull);
          }

          // Populate fetched repos
          for (const r of this.userRepos) {
            if (r.full_name && r.full_name !== currentFull) {
              drop.addOption(r.full_name, `${r.full_name}${r.private ? " (private)" : ""}`);
            }
          }

          drop.addOption(CREATE_NEW_REPO_VAL, "+ Create new private repository for this vault");
          drop.addOption(CUSTOM_REMOTE_VAL, "✏️ Enter custom remote URL…");

          drop.setValue(currentFull);
          drop.onChange(async (val) => {
            if (val === CREATE_NEW_REPO_VAL) {
              await this.plugin.initializeRepo(settings.githubToken, settings.githubUsername);
              this.display();
            } else if (val === CUSTOM_REMOTE_VAL) {
              this.display();
            } else {
              const parsed = parseGitHubRepo(val);
              if (parsed) {
                settings.githubUsername = parsed.owner;
                settings.repoName = parsed.repo;
                settings.remoteUrl = formatRemoteUrl(parsed.owner, parsed.repo);
                await this.plugin.saveSettings();
                await this.plugin.bootSyncEngine();
                new Notice(`GitOrbit: Switched to repository ${val}`);
                this.display();
              }
            }
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

      // Lazily trigger repository fetch if not yet loaded
      if (!this.reposFetched) {
        this.loadRepositories(false);
      }

      // ── Remote Clone URL Text Field ──
      const remoteUrlSetting = new Setting(containerEl)
        .setName("Remote URL")
        .setDesc("HTTPS clone URL of the remote GitHub repository.")
        .addText((text) =>
          text
            .setPlaceholder("https://github.com/owner/repository.git")
            .setValue(settings.remoteUrl || formatRemoteUrl(settings.githubUsername, settings.repoName))
            .onChange(async (val) => {
              const trimmed = val.trim();
              settings.remoteUrl = trimmed;

              const parsed = parseGitHubRepo(trimmed);
              if (parsed) {
                settings.githubUsername = parsed.owner;
                settings.repoName = parsed.repo;
              }

              updateRemoteHint();
              await this.plugin.saveSettings();
              await this.plugin.bootSyncEngine();
            })
        );

      // Non-blocking real-time validation hint
      const hintDiv = remoteUrlSetting.descEl.createDiv();
      hintDiv.style.cssText = "font-size:11px;margin-top:4px;";
      const updateRemoteHint = () => {
        const hint = remoteUrlHint(settings.remoteUrl);
        if (hint) {
          hintDiv.textContent = `⚠️ ${hint}`;
          hintDiv.style.color = "var(--text-warning)";
        } else if (settings.remoteUrl) {
          hintDiv.textContent = `✓ Valid remote: ${settings.githubUsername}/${settings.repoName}`;
          hintDiv.style.color = "var(--text-success)";
        } else {
          hintDiv.textContent = "";
        }
      };
      updateRemoteHint();

      // Disconnect Button
      new Setting(containerEl)
        .setName("Disconnect account")
        .setDesc("Unlink this device from the remote GitHub repository.")
        .addButton((btn) =>
          btn
            .setButtonText("Disconnect")
            .setWarning()
            .onClick(async () => {
              settings.githubToken = "";
              settings.githubUsername = "";
              settings.repoName = "";
              settings.remoteUrl = "";
              await this.plugin.saveSettings();
              this.display();
              new Notice("GitOrbit: Disconnected from GitHub.");
            })
        );
    } else {
      // Disconnected State: Dual Auth Choice
      new Setting(containerEl)
        .setName("Authentication method")
        .setDesc("Choose between 1-click browser authorization (Device Flow) or entering your own Personal Access Token (PAT).")
        .addDropdown((drop) =>
          drop
            .addOption("oauth", "Browser Login (OAuth Device Flow)")
            .addOption("pat", "Personal Access Token (PAT)")
            .setValue(settings.authType)
            .onChange(async (val) => {
              settings.authType = val as "oauth" | "pat";
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
        // Personal Access Token UI
        let tempPat = "";
        new Setting(containerEl)
          .setName("GitHub Personal Access Token")
          .setDesc(
            "Create a token at github.com/settings/tokens with 'repo' scope enabled (both Classic and Fine-grained tokens work)."
          )
          .addText((text) => {
            text.inputEl.type = "password";
            text
              .setPlaceholder("ghp_xxxxxxxxxxxxxxxxxxxx")
              .onChange((val) => {
                tempPat = val.trim();
              });
          })
          .addButton((btn) =>
            btn
              .setButtonText("Verify & Connect")
              .setCta()
              .onClick(async () => {
                if (!tempPat) {
                  new Notice("Please enter a valid GitHub token.");
                  return;
                }
                btn.setButtonText("Verifying…").setDisabled(true);
                try {
                  const user = await getAuthenticatedUser(tempPat);
                  settings.githubToken = tempPat;
                  settings.githubUsername = user.login;
                  await this.plugin.initializeRepo(tempPat, user.login);
                  await this.plugin.saveSettings();
                  new Notice(`GitOrbit: Connected as @${user.login}!`);
                  this.display();
                } catch (err) {
                  const msg = err instanceof Error ? err.message : String(err);
                  new Notice(`GitOrbit: Token verification failed: ${msg}`);
                  btn.setButtonText("Verify & Connect").setDisabled(false);
                }
              })
          );
      }
    }

    // ── Automatic Synchronization Options ────────────────────────────────────
    containerEl.createEl("h3", { text: "Automatic Synchronization Options" });

    // 1. Sync on Edit (autoSync)
    new Setting(containerEl)
      .setName("Sync on file edits")
      .setDesc("Automatically commit and push changes after editing vault notes.")
      .addToggle((toggle) =>
        toggle.setValue(settings.autoSync).onChange(async (val) => {
          settings.autoSync = val;
          await this.plugin.saveSettings();
        })
      );

    // 2. Debounce window
    new Setting(containerEl)
      .setName("Sync debounce (ms)")
      .setDesc("Wait time in milliseconds after the last file edit before initiating background commit & push.")
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

    // 3. Sync on Startup (syncOnStartup)
    new Setting(containerEl)
      .setName("Sync on startup")
      .setDesc("Automatically pull and merge the latest changes from GitHub when Obsidian opens.")
      .addToggle((toggle) =>
        toggle.setValue(settings.syncOnStartup).onChange(async (val) => {
          settings.syncOnStartup = val;
          await this.plugin.saveSettings();
        })
      );

    // 4. Periodic Background Sync (periodicSync)
    new Setting(containerEl)
      .setName("Periodic background sync")
      .setDesc("Periodically check for remote updates and push local notes in the background on a recurring timer.")
      .addToggle((toggle) =>
        toggle.setValue(settings.periodicSync).onChange(async (val) => {
          settings.periodicSync = val;
          await this.plugin.saveSettings();
          this.plugin.restartPeriodicSync();
          this.display();
        })
      );

    // 5. Periodic Interval (Only visible if periodicSync is enabled)
    if (settings.periodicSync) {
      new Setting(containerEl)
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
    }

    // ── Sync Engine & Git Branch ─────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Sync Engine & Branch" });

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

    new Setting(containerEl)
      .setName("Git Branch")
      .setDesc("Remote target branch for synchronizing commits.")
      .addText((text) =>
        text
          .setPlaceholder("main")
          .setValue(settings.branch || "main")
          .onChange(async (val) => {
            settings.branch = val.trim() || "main";
            await this.plugin.saveSettings();
          })
      );

    // ── Commit Customization ─────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Git Commit Identity & Message" });

    new Setting(containerEl)
      .setName("Commit message template")
      .setDesc("Template for automated sync commits. Supports {{datetime}} (full ISO timestamp) and {{date}} (YYYY-MM-DD).")
      .addText((text) =>
        text
          .setPlaceholder("sync: {{datetime}}")
          .setValue(settings.commitMessageTemplate || "sync: {{datetime}}")
          .onChange(async (val) => {
            settings.commitMessageTemplate = val.trim() || "sync: {{datetime}}";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Author Name")
      .setDesc("Git author name attached to automated sync commits.")
      .addText((text) =>
        text
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
          .setValue(settings.authorEmail)
          .onChange(async (val) => {
            settings.authorEmail = val.trim() || "sync@gitorbit.local";
            await this.plugin.saveSettings();
          })
      );

    // ── Excluded Files ───────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Excluded Paths & Globs" });

    new Setting(containerEl)
      .setName("Excluded patterns")
      .setDesc("One glob pattern per line. Matching files will be completely excluded from git sync.")
      .addTextArea((ta) =>
        ta
          .setValue(settings.excludePatterns.join("\n"))
          .onChange(async (val) => {
            settings.excludePatterns = val
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean);
            await this.plugin.saveSettings();
          })
      );

    // ── Manual Operations ───────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Manual Maintenance" });

    new Setting(containerEl)
      .setName("Sync now")
      .setDesc("Pull remote updates and push all pending local changes immediately.")
      .addButton((btn) =>
        btn.setButtonText("Sync Now").onClick(async () => {
          btn.setButtonText("Syncing…").setDisabled(true);
          await this.plugin.triggerManualSync(false);
          btn.setButtonText("Sync Now").setDisabled(false);
        })
      );

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
  }

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

  private async startDeviceFlow(btn: ButtonComponent): Promise<void> {
    btn.setButtonText("Connecting…").setDisabled(true);

    try {
      const deviceFlow = await requestDeviceCode(this.plugin.settings.clientId);

      // Render modal code card
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

      // Open browser
      window.open(deviceFlow.verification_uri, "_blank");

      // Poll with resilient network retry
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

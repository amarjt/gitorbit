import { App, PluginSettingTab, Setting, Notice, ButtonComponent } from "obsidian";
import type GitOrbitPlugin from "../main";
import { requestDeviceCode, pollForToken } from "../auth/github-device";
import { getAuthenticatedUser } from "../github/api";
import { DEFAULT_CLIENT_ID } from "../constants";

export class GitOrbitSettingsTab extends PluginSettingTab {
  plugin: GitOrbitPlugin;

  constructor(app: App, plugin: GitOrbitPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "GitOrbit Settings" });
    const settings = this.plugin.settings;

    // ── Authentication Section ──────────────────────────────────────────────
    containerEl.createEl("h3", { text: "GitHub Connection" });

    if (settings.githubToken && settings.githubUsername) {
      // Connected State
      const card = containerEl.createDiv({ cls: "gitorbit-connected-card" });
      card.style.cssText =
        "background:var(--background-secondary);padding:14px;border-radius:8px;" +
        "border:1px solid var(--interactive-accent);margin-bottom:14px;";

      card.createEl("div", {
        text: `Connected to GitHub as @${settings.githubUsername} (${settings.authType === "pat" ? "Personal Access Token" : "OAuth Device Flow"})`,
        cls: "setting-item-name",
      });

      card.createEl("div", {
        text: `Target Repository: https://github.com/${settings.githubUsername}/${settings.repoName}`,
        cls: "setting-item-description",
      });

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

    // ── Sync Options ────────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Sync Options" });

    new Setting(containerEl)
      .setName("Automatic synchronization")
      .setDesc("Automatically commit and push changes after editing vault notes.")
      .addToggle((toggle) =>
        toggle.setValue(settings.autoSync).onChange(async (val) => {
          settings.autoSync = val;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Sync debounce (ms)")
      .setDesc("Wait time in milliseconds after last file change before pushing.")
      .addSlider((slider) =>
        slider
          .setLimits(1000, 10000, 500)
          .setValue(settings.syncIntervalMs)
          .setDynamicTooltip()
          .onChange(async (val) => {
            settings.syncIntervalMs = val;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Excluded patterns")
      .setDesc("One glob pattern per line. Files matching these patterns will never be synced.")
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

    // ── Commit Identity ─────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Git Commit Identity" });

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

    // ── Manual Operations ───────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Manual Sync" });

    new Setting(containerEl)
      .setName("Sync now")
      .setDesc("Pull remote updates and push all pending local changes immediately.")
      .addButton((btn) =>
        btn.setButtonText("Sync Now").onClick(async () => {
          await this.plugin.triggerManualSync();
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

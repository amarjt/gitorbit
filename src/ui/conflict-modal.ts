import { App, Modal, ButtonComponent, Platform } from "obsidian";
import { ConflictFile } from "../types";
import {
  diffSummary,
  mergeExtraContents,
  extractExtraLines,
  looksBinary,
} from "../sync/conflict";

type ResolveCallback = (filepath: string, resolvedContent: string) => Promise<void>;

type ViewTab = "merged" | "ours" | "theirs" | "diff" | "split";

export class ConflictModal extends Modal {
  private conflicts: ConflictFile[];
  private currentIndex = 0;
  private onResolve: ResolveCallback;
  private activeTab: ViewTab = "merged";
  private currentEditedContent = "";

  constructor(app: App, conflicts: ConflictFile[], onResolve: ResolveCallback) {
    super(app);
    this.conflicts = conflicts;
    this.onResolve = onResolve;
  }

  onOpen(): void {
    // Responsive modal sizing: expand to fill mobile screen comfortably
    this.modalEl.addClass("gitorbit-conflict-modal");
    this.modalEl.style.width = Platform.isMobile ? "96vw" : "780px";
    this.modalEl.style.maxWidth = "860px";
    this.modalEl.style.maxHeight = Platform.isMobile ? "92vh" : "85vh";

    this.renderCurrent();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private renderCurrent(): void {
    const conflict = this.conflicts[this.currentIndex];
    const { contentEl } = this;
    contentEl.empty();

    const isBinary = looksBinary(conflict.ours) || looksBinary(conflict.theirs);
    const extraLines = isBinary ? [] : extractExtraLines(conflict.ours, conflict.theirs);
    const initialMerged = isBinary ? "" : mergeExtraContents(conflict.ours, conflict.theirs);
    this.currentEditedContent = initialMerged;

    // Header & Navigation
    const headerEl = contentEl.createDiv({ cls: "gitorbit-conflict-header" });
    headerEl.style.cssText = "margin-bottom:12px;border-bottom:1px solid var(--background-modifier-border);padding-bottom:8px;";

    const titleRow = headerEl.createDiv();
    titleRow.style.cssText = "display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px;";

    titleRow.createEl("h3", {
      text: `Sync Conflict (${this.currentIndex + 1} of ${this.conflicts.length})`,
      cls: "gitorbit-conflict-title",
    });

    if (this.conflicts.length > 1) {
      const badge = titleRow.createEl("span", {
        text: `${this.conflicts.length - this.currentIndex - 1} remaining`,
      });
      badge.style.cssText = "font-size:11px;background:var(--background-modifier-accent);color:var(--text-on-accent);padding:2px 8px;border-radius:12px;";
    }

    const pathEl = headerEl.createEl("p", {
      text: conflict.path,
      cls: "gitorbit-conflict-filepath",
    });
    pathEl.style.cssText = "font-size:12px;color:var(--text-muted);font-family:var(--font-monospace);word-break:break-all;margin:4px 0 0 0;";

    // Responsive Segmented View Tabs
    const tabContainer = contentEl.createDiv({ cls: "gitorbit-conflict-tabs" });
    tabContainer.style.cssText =
      "display:flex;gap:4px;margin-bottom:10px;overflow-x:auto;padding-bottom:4px;" +
      "border-bottom:1px solid var(--background-modifier-border-focus);";

    const tabs: Array<{ id: ViewTab; label: string }> = [];
    if (!isBinary) {
      tabs.push({ id: "merged", label: `✨ Merged (+${extraLines.length})` });
    }
    tabs.push({ id: "ours", label: "📱 Local (Mine)" });
    tabs.push({ id: "theirs", label: "☁️ Remote (GitHub)" });
    if (!isBinary) {
      tabs.push({ id: "diff", label: "🔍 Differences" });
      if (!Platform.isMobile) {
        tabs.push({ id: "split", label: "↔️ Side-by-Side" });
      }
    }

    if (isBinary && (this.activeTab === "merged" || this.activeTab === "diff" || this.activeTab === "split")) {
      this.activeTab = "ours";
    }

    const tabButtons = new Map<ViewTab, HTMLButtonElement>();
    for (const t of tabs) {
      const btn = tabContainer.createEl("button", { text: t.label });
      btn.style.cssText =
        "font-size:12px;padding:6px 12px;border-radius:4px;cursor:pointer;white-space:nowrap;" +
        "border:none;transition:background 0.15s ease;";
      this.styleTabButton(btn, this.activeTab === t.id);

      btn.addEventListener("click", () => {
        this.activeTab = t.id;
        for (const [id, b] of tabButtons) {
          this.styleTabButton(b, this.activeTab === id);
        }
        this.renderActiveTab(tabViewArea, conflict, isBinary);
      });
      tabButtons.set(t.id, btn);
    }

    // Active View Container
    const tabViewArea = contentEl.createDiv({ cls: "gitorbit-conflict-view-area" });
    tabViewArea.style.cssText = "margin-bottom:12px;";
    this.renderActiveTab(tabViewArea, conflict, isBinary);

    // Responsive Action Buttons Toolbar
    const actionsEl = contentEl.createDiv({ cls: "gitorbit-conflict-actions" });
    actionsEl.style.cssText =
      "display:grid;grid-template-columns:repeat(auto-fit, minmax(130px, 1fr));gap:8px;margin-top:14px;";

    // 1. Merge Extra Contents Button
    if (!isBinary) {
      const mergeBtn = new ButtonComponent(actionsEl)
        .setButtonText(extraLines.length > 0 ? `Merge Extra (+${extraLines.length})` : "Merge Both")
        .setCta()
        .onClick(async () => {
          mergeBtn.setDisabled(true);
          const finalContent = this.currentEditedContent || initialMerged;
          await this.resolve(conflict, finalContent);
        });
      mergeBtn.buttonEl.style.cssText = "min-height:38px;font-weight:600;";
    }

    // 2. Keep Mine
    const mineBtn = new ButtonComponent(actionsEl)
      .setButtonText("Keep Mine")
      .onClick(async () => {
        mineBtn.setDisabled(true);
        await this.resolve(conflict, conflict.ours);
      });
    mineBtn.buttonEl.style.cssText = "min-height:38px;";

    // 3. Keep Theirs
    const theirsBtn = new ButtonComponent(actionsEl)
      .setButtonText("Keep Theirs")
      .onClick(async () => {
        theirsBtn.setDisabled(true);
        await this.resolve(conflict, conflict.theirs);
      });
    theirsBtn.buttonEl.style.cssText = "min-height:38px;";

    // 4. Open in Editor
    const editBtn = new ButtonComponent(actionsEl)
      .setButtonText("Open in Editor")
      .onClick(() => {
        this.close();
        this.app.workspace.openLinkText(conflict.path, "", true);
      });
    editBtn.buttonEl.style.cssText = "min-height:38px;";
  }

  private styleTabButton(btn: HTMLButtonElement, active: boolean): void {
    if (active) {
      btn.style.background = "var(--interactive-accent)";
      btn.style.color = "var(--text-on-accent)";
      btn.style.fontWeight = "600";
    } else {
      btn.style.background = "var(--background-secondary)";
      btn.style.color = "var(--text-muted)";
      btn.style.fontWeight = "normal";
    }
  }

  private renderActiveTab(container: HTMLElement, conflict: ConflictFile, isBinary: boolean): void {
    container.empty();

    if (isBinary) {
      const warn = container.createDiv({ cls: "gitorbit-binary-warning" });
      warn.style.cssText =
        "background:var(--background-secondary);padding:14px;border-radius:6px;border:1px solid var(--text-warning);";
      warn.createEl("p", {
        text: "Binary file conflict detected (e.g. image, canvas, or attachment). Text merge is not available.",
      });
      warn.createEl("p", {
        text: "Please select either 'Keep Mine' to preserve this device's copy or 'Keep Theirs' to accept the GitHub version.",
        cls: "setting-item-description",
      });
      return;
    }

    const maxHeight = Platform.isMobile ? "45vh" : "280px";

    switch (this.activeTab) {
      case "merged": {
        const hint = container.createDiv();
        hint.style.cssText = "font-size:12px;color:var(--text-muted);margin-bottom:6px;";
        hint.createEl("span", {
          text: "Smart Merge: only extra remote lines were integrated without repeating common text. You can also edit below before resolving:",
        });

        const textarea = container.createEl("textarea", { cls: "gitorbit-merge-editor" });
        textarea.style.cssText =
          `width:100%;height:${maxHeight};min-height:180px;background:var(--background-primary-alt);` +
          "border:1px solid var(--interactive-accent);border-radius:6px;padding:8px 10px;" +
          "font-family:var(--font-monospace);font-size:12px;line-height:1.45;resize:vertical;";
        textarea.value = this.currentEditedContent;
        textarea.addEventListener("input", () => {
          this.currentEditedContent = textarea.value;
        });
        break;
      }

      case "ours": {
        const pre = container.createEl("pre", { cls: "gitorbit-preview-box" });
        pre.style.cssText =
          `background:var(--background-primary-alt);border:1px solid var(--interactive-accent);` +
          `padding:10px;border-radius:6px;overflow:auto;max-height:${maxHeight};font-size:11px;` +
          "white-space:pre-wrap;font-family:var(--font-monospace);";
        pre.textContent = conflict.ours || "(Empty file)";
        break;
      }

      case "theirs": {
        const pre = container.createEl("pre", { cls: "gitorbit-preview-box" });
        pre.style.cssText =
          `background:var(--background-primary-alt);border:1px solid var(--text-accent);` +
          `padding:10px;border-radius:6px;overflow:auto;max-height:${maxHeight};font-size:11px;` +
          "white-space:pre-wrap;font-family:var(--font-monospace);";
        pre.textContent = conflict.theirs || "(Empty file)";
        break;
      }

      case "diff": {
        const diffPre = container.createEl("pre", { cls: "gitorbit-diff-summary" });
        diffPre.style.cssText =
          `background:var(--background-secondary);padding:10px;border-radius:6px;` +
          `border:1px solid var(--background-modifier-border);overflow:auto;max-height:${maxHeight};` +
          "font-size:11px;font-family:var(--font-monospace);white-space:pre-wrap;";
        diffPre.textContent = diffSummary(conflict);
        break;
      }

      case "split": {
        const cols = container.createDiv({ cls: "gitorbit-conflict-columns" });
        cols.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:12px;";

        const oursCol = cols.createDiv();
        oursCol.createEl("h5", { text: "Your Version (This Device)", cls: "setting-item-name" });
        const oursPre = oursCol.createEl("pre");
        oursPre.style.cssText =
          `background:var(--background-primary-alt);border:1px solid var(--interactive-accent);` +
          `padding:10px;border-radius:6px;overflow:auto;max-height:${maxHeight};font-size:11px;` +
          "white-space:pre-wrap;font-family:var(--font-monospace);";
        oursPre.textContent = conflict.ours || "(Empty file)";

        const theirsCol = cols.createDiv();
        theirsCol.createEl("h5", { text: "Remote Version (GitHub)", cls: "setting-item-name" });
        const theirsPre = theirsCol.createEl("pre");
        theirsPre.style.cssText =
          `background:var(--background-primary-alt);border:1px solid var(--text-accent);` +
          `padding:10px;border-radius:6px;overflow:auto;max-height:${maxHeight};font-size:11px;` +
          "white-space:pre-wrap;font-family:var(--font-monospace);";
        theirsPre.textContent = conflict.theirs || "(Empty file)";
        break;
      }
    }
  }

  private async resolve(conflict: ConflictFile, content: string): Promise<void> {
    await this.onResolve(conflict.path, content);
    this.currentIndex++;
    if (this.currentIndex < this.conflicts.length) {
      this.renderCurrent();
    } else {
      this.close();
    }
  }
}

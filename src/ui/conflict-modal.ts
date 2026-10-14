import { App, Modal, Setting, Component } from "obsidian";
import { ConflictFile } from "../types";
import { diffSummary } from "../sync/conflict";

type ResolveCallback = (filepath: string, resolvedContent: string) => Promise<void>;

export class ConflictModal extends Modal {
  private conflicts: ConflictFile[];
  private currentIndex = 0;
  private onResolve: ResolveCallback;
  private component: Component;

  constructor(app: App, conflicts: ConflictFile[], onResolve: ResolveCallback) {
    super(app);
    this.conflicts = conflicts;
    this.onResolve = onResolve;
    this.component = new Component();
  }

  onOpen(): void {
    this.component.load();
    this.renderCurrent();
  }

  onClose(): void {
    this.component.unload();
    this.contentEl.empty();
  }

  private renderCurrent(): void {
    const conflict = this.conflicts[this.currentIndex];
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", {
      text: `Sync Conflict (${this.currentIndex + 1} of ${this.conflicts.length})`,
    });

    contentEl.createEl("p", {
      text: `File: ${conflict.path}`,
      cls: "gitorbit-conflict-filepath",
    });

    // Diff summary container
    const diffEl = contentEl.createEl("pre", { cls: "gitorbit-diff-summary" });
    diffEl.style.cssText =
      "background:var(--background-secondary);padding:10px;border-radius:6px;" +
      "border:1px solid var(--background-modifier-border);" +
      "overflow:auto;max-height:160px;font-size:12px;font-family:var(--font-monospace);";
    diffEl.textContent = diffSummary(conflict);

    // Side-by-side comparison grid
    const cols = contentEl.createDiv({ cls: "gitorbit-conflict-columns" });
    cols.style.cssText =
      "display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:12px 0;";

    // Local / Ours
    const oursCol = cols.createDiv();
    oursCol.createEl("h4", { text: "Your Version (This Device)" });
    const oursPre = oursCol.createEl("pre");
    oursPre.style.cssText =
      "background:var(--background-primary-alt);border:1px solid var(--interactive-accent);" +
      "padding:10px;border-radius:6px;overflow:auto;max-height:240px;font-size:11px;" +
      "white-space:pre-wrap;font-family:var(--font-monospace);";
    oursPre.textContent =
      conflict.ours.slice(0, 3000) +
      (conflict.ours.length > 3000 ? "\n…(truncated)" : "");

    // Remote / Theirs
    const theirsCol = cols.createDiv();
    theirsCol.createEl("h4", { text: "Remote Version (GitHub)" });
    const theirsPre = theirsCol.createEl("pre");
    theirsPre.style.cssText =
      "background:var(--background-primary-alt);border:1px solid var(--text-accent);" +
      "padding:10px;border-radius:6px;overflow:auto;max-height:240px;font-size:11px;" +
      "white-space:pre-wrap;font-family:var(--font-monospace);";
    theirsPre.textContent =
      conflict.theirs.slice(0, 3000) +
      (conflict.theirs.length > 3000 ? "\n…(truncated)" : "");

    // Action buttons
    new Setting(contentEl)
      .addButton((btn) =>
        btn.setButtonText("Keep Mine").onClick(async () => {
          await this.resolve(conflict, conflict.ours);
        })
      )
      .addButton((btn) =>
        btn
          .setButtonText("Keep Theirs")
          .setCta()
          .onClick(async () => {
            await this.resolve(conflict, conflict.theirs);
          })
      )
      .addButton((btn) =>
        btn.setButtonText("Combine Both").onClick(async () => {
          const combined = `${conflict.ours.trim()}\n\n---\n*Merged from remote:*\n\n${conflict.theirs.trim()}\n`;
          await this.resolve(conflict, combined);
        })
      )
      .addButton((btn) =>
        btn.setButtonText("Open in Editor").onClick(() => {
          this.close();
          this.app.workspace.openLinkText(conflict.path, "", true);
        })
      );
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

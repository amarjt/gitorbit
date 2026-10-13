import { Plugin } from "obsidian";
import { SyncStatus } from "../types";

const STATUS_ICONS: Record<SyncStatus, string> = {
  idle:       "✓ GitOrbit",
  pulling:    "↓ Pulling…",
  pushing:    "↑ Pushing…",
  conflict:   "⚠ Conflict",
  error:      "✗ Sync Error",
  connecting: "… Connecting",
};

export class StatusBarItem {
  private el: HTMLElement;
  private clickHandler: (() => void) | null = null;

  constructor(plugin: Plugin) {
    this.el = plugin.addStatusBarItem();
    this.el.style.cursor = "pointer";
    this.el.title = "Click to sync vault now with GitHub";
    this.set("idle");
  }

  set(status: SyncStatus, detail?: string): void {
    const label = STATUS_ICONS[status] || "GitOrbit";
    this.el.setText(detail ? `${label}: ${detail}` : label);
    this.el.setAttribute("data-sync-status", status);
    if (detail) {
      this.el.title = detail;
    } else {
      this.el.title = `GitOrbit: ${status}. Click to sync now.`;
    }
  }

  onClick(handler: () => void): void {
    this.clickHandler = handler;
    this.el.addEventListener("click", handler);
  }

  destroy(): void {
    if (this.clickHandler) {
      this.el.removeEventListener("click", this.clickHandler);
      this.clickHandler = null;
    }
    this.el.remove();
  }
}

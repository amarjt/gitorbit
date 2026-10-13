import { GitSync } from "./git-sync";
import { SyncResult, SyncStatus } from "../types";

type StatusCallback = (status: SyncStatus, detail?: string) => void;

export class SyncQueue {
  private pendingFiles = new Set<string>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private gitSync: GitSync;
  private onStatus: StatusCallback;
  private debounceMs: number;

  constructor(gitSync: GitSync, onStatus: StatusCallback, debounceMs: number = 3000) {
    this.gitSync = gitSync;
    this.onStatus = onStatus;
    this.debounceMs = debounceMs;
  }

  setDebounceMs(ms: number): void {
    this.debounceMs = Math.max(ms, 500);
  }

  /** Enqueue a file path and schedule debounced sync */
  enqueue(filepath: string): void {
    this.pendingFiles.add(filepath);
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => this.flush(), this.debounceMs);
  }

  /** Drain queue immediately (called during vault unload or manual sync) */
  async flushNow(): Promise<SyncResult | null> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    return this.flush();
  }

  /** Teardown timers to prevent leaks */
  destroy(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.pendingFiles.clear();
  }

  private async flush(): Promise<SyncResult | null> {
    if (this.running || this.pendingFiles.size === 0) return null;

    this.running = true;
    const filesToSync = [...this.pendingFiles];
    this.pendingFiles.clear();

    try {
      this.onStatus("pushing");
      const result = await this.gitSync.sync(filesToSync);

      if (result.conflictFiles.length > 0) {
        this.onStatus("conflict");
      } else if (result.success) {
        this.onStatus("idle");
      } else {
        this.onStatus("error", result.error);
      }

      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.onStatus("error", msg);
      return { success: false, conflictFiles: [], error: msg };
    } finally {
      this.running = false;
      if (this.pendingFiles.size > 0) {
        setTimeout(() => this.flush(), 500);
      }
    }
  }
}

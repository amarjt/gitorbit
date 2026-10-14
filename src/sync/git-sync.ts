import * as git from "isomorphic-git";
import { requestUrl, DataAdapter } from "obsidian";
import { createFsAdapter } from "./fs-adapter";
import { DEFAULT_BRANCH } from "../constants";
import { ConflictFile, SyncResult } from "../types";

// Custom HTTP transport wrapping Obsidian's native requestUrl (works on desktop & mobile, bypasses CORS)
const gitHttp: git.HttpClient = {
  async request({ url, method = "GET", headers = {}, body }: git.GitHttpRequest): Promise<git.GitHttpResponse> {
    let bodyBuffer: ArrayBuffer | undefined;
    if (body) {
      const chunks: Uint8Array[] = [];
      for await (const chunk of body) chunks.push(chunk);
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      bodyBuffer = merged.buffer;
    }

    const response = await requestUrl({
      url,
      method,
      headers,
      body: bodyBuffer,
      throw: false,
    });

    const arrayBuffer = response.arrayBuffer;
    async function* responseBody() {
      yield new Uint8Array(arrayBuffer);
    }

    return {
      url,
      method,
      statusCode: response.status,
      statusMessage: "OK",
      body: responseBody(),
      headers: response.headers as Record<string, string>,
    };
  },
};

export class GitSync {
  private fs: ReturnType<typeof createFsAdapter>;
  private dir: string;
  private token: string;
  private username: string;
  private remoteUrl: string;
  private authorName: string;
  private authorEmail: string;
  private latestRemoteHead: string | null = null;

  constructor(
    adapter: DataAdapter,
    vaultPath: string,
    token: string,
    username: string,
    repoName: string,
    authorName: string = "GitOrbit",
    authorEmail: string = "sync@gitorbit.local"
  ) {
    this.fs = createFsAdapter(adapter, vaultPath);
    this.dir = vaultPath;
    this.token = token;
    this.username = username;
    this.remoteUrl = `https://github.com/${username}/${repoName}.git`;
    this.authorName = authorName;
    this.authorEmail = authorEmail;
  }

  private gitOpts() {
    return {
      fs: this.fs,
      http: gitHttp,
      dir: this.dir,
      author: { name: this.authorName, email: this.authorEmail },
    };
  }

  private netOpts() {
    const token = this.token;
    const username = this.username;
    return {
      ...this.gitOpts(),
      url: this.remoteUrl,
      onAuth: () => ({ username, password: token }),
      onAuthFailure: () => {
        throw new Error("GitHub authentication failed. Please check your token or reconnect in GitOrbit settings.");
      },
    };
  }

  /** Returns true if .git exists and HEAD can be resolved */
  async isInitialized(): Promise<boolean> {
    try {
      await git.resolveRef({ fs: this.fs, dir: this.dir, ref: "HEAD" });
      return true;
    } catch {
      return false;
    }
  }

  /** Returns true if refs/heads/main exists */
  async hasLocalBranch(): Promise<boolean> {
    try {
      await git.resolveRef({ fs: this.fs, dir: this.dir, ref: DEFAULT_BRANCH });
      return true;
    } catch {
      return false;
    }
  }

  /** Fetch from remote origin */
  private async safeFetch(): Promise<string | null> {
    try {
      const res = await git.fetch({
        ...this.netOpts(),
        remote: "origin",
        ref: DEFAULT_BRANCH,
        remoteRef: DEFAULT_BRANCH,
        singleBranch: true,
        tags: false,
      });
      const head = res.fetchHead ?? null;
      if (head) {
        this.latestRemoteHead = head;
      }
      return head;
    } catch (err) {
      console.warn("GitOrbit safeFetch failed:", err);
      return null;
    }
  }

  /** Clone remote into vault */
  async clone(): Promise<boolean> {
    await git.clone({
      ...this.netOpts(),
      singleBranch: true,
    });
    // Ensure working tree is checked out to disk
    try {
      await git.checkout({
        fs: this.fs,
        dir: this.dir,
        ref: DEFAULT_BRANCH,
        force: true,
      });
    } catch {
      // Empty remote repo
    }
    return this.hasLocalBranch();
  }

  /** Reconciles remote commit into local working tree, returning detected conflict files if any */
  private async reconcileRemote(remoteOid: string): Promise<ConflictFile[]> {
    const localHead = await git.resolveRef({
      fs: this.fs,
      dir: this.dir,
      ref: DEFAULT_BRANCH,
    });

    if (remoteOid === localHead) return [];

    try {
      await git.merge({
        fs: this.fs,
        dir: this.dir,
        ours: DEFAULT_BRANCH,
        theirs: remoteOid,
        author: { name: this.authorName, email: this.authorEmail },
        message: "sync: merge remote changes",
        fastForward: true,
        fastForwardOnly: false,
        allowUnrelatedHistories: true,
        abortOnConflict: true,
      });

      // Write updated remote files to physical disk (Issue #4 fix)
      await git.checkout({
        fs: this.fs,
        dir: this.dir,
        ref: DEFAULT_BRANCH,
        force: true,
      });
      return [];
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Check if it's a MergeConflictError
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const isConflict =
        (err as any)?.code === "MergeConflictError" ||
        msg.includes("Automatic merge failed") ||
        msg.includes("merge conflicts");

      if (isConflict) {
        console.warn("GitOrbit: Detected merge conflict during remote reconciliation:", msg);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let conflictPaths: string[] = (err as any)?.data?.filepaths ?? [];
        if (conflictPaths.length === 0) {
          const match = msg.match(/in the following files:\s*([^.]+)\./);
          if (match && match[1]) {
            conflictPaths = match[1].split(",").map((s) => s.trim());
          }
        }

        const conflictFiles: ConflictFile[] = [];
        for (const filepath of conflictPaths) {
          const ours = await this.readFileContent(filepath);
          const theirs = await this.readRemoteFileContent(filepath);
          conflictFiles.push({ path: filepath, ours, theirs });
        }
        return conflictFiles;
      }
      throw err;
    }
  }

  /** Pushes to remote with auto-recovery retry on non-fast-forward rejection */
  private async pushWithRecovery(retryCount = 1): Promise<void> {
    try {
      await git.push({
        ...this.netOpts(),
        ref: DEFAULT_BRANCH,
        force: false,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const isNonFastForward =
        msg.includes("not a simple fast-forward") ||
        msg.includes("Push rejected") ||
        msg.includes("PushRejectedError");

      if (retryCount > 0 && isNonFastForward) {
        console.log("GitOrbit: Push rejected (non-fast-forward). Re-fetching remote and reconciling...");
        const freshHead = await this.safeFetch();
        if (freshHead) {
          const conflicts = await this.reconcileRemote(freshHead);
          if (conflicts.length === 0) {
            return await this.pushWithRecovery(retryCount - 1);
          } else {
            throw new Error(`Automatic merge failed with conflicts in: ${conflicts.map((c) => c.path).join(", ")}`);
          }
        }
      }
      throw err;
    }
  }

  /** Initial vault snapshot creation and initial push */
  async initAndPush(vaultFiles: string[]): Promise<void> {
    const alreadyInited = await this.isInitialized();
    if (!alreadyInited) {
      await git.init({ fs: this.fs, dir: this.dir, defaultBranch: DEFAULT_BRANCH });
    }

    for (const file of vaultFiles) {
      try {
        await git.add({ fs: this.fs, dir: this.dir, filepath: file });
      } catch {
        // Skip unstageable files
      }
    }

    const localBranchExists = await this.hasLocalBranch();
    if (!localBranchExists) {
      await git.commit({
        ...this.gitOpts(),
        message: "sync: initial vault snapshot",
      });
    } else {
      const status = await git.statusMatrix({ fs: this.fs, dir: this.dir });
      const dirty = status.some(([, h, w, s]) => h !== 1 || w !== 1 || s !== 1);
      if (dirty) {
        await git.commit({
          ...this.gitOpts(),
          message: "sync: initial vault snapshot",
        });
      }
    }

    try {
      await git.deleteRemote({ fs: this.fs, dir: this.dir, remote: "origin" });
    } catch {
      // Remote did not exist yet
    }
    await git.addRemote({
      fs: this.fs,
      dir: this.dir,
      remote: "origin",
      url: this.remoteUrl,
    });

    await this.pushWithRecovery();
  }

  /** Full sync cycle: stage -> commit -> fetch -> merge & checkout disk -> push */
  async sync(changedFiles: string[]): Promise<SyncResult> {
    const conflicts: ConflictFile[] = [];

    try {
      // 1. Stage or remove changed files
      for (const file of changedFiles) {
        try {
          await git.add({ fs: this.fs, dir: this.dir, filepath: file });
        } catch {
          try {
            await git.remove({ fs: this.fs, dir: this.dir, filepath: file });
          } catch {
            // Ignore if missing
          }
        }
      }

      // 2. Commit dirty files
      let hasDirty = false;
      try {
        const matrix = await git.statusMatrix({ fs: this.fs, dir: this.dir });
        hasDirty = matrix.some(([, h, w, s]) => h !== 1 || w !== 1 || s !== 1);
      } catch {
        hasDirty = changedFiles.length > 0;
      }

      if (hasDirty) {
        const now = new Date().toISOString().replace("T", " ").slice(0, 19);
        await git.commit({
          ...this.gitOpts(),
          message: `sync: ${now}`,
        });
      }

      // 3. Fetch remote
      const fetchHead = await this.safeFetch();

      // 4. Merge remote & Checkout working tree to disk
      if (fetchHead && (await this.hasLocalBranch())) {
        const mergeConflicts = await this.reconcileRemote(fetchHead);
        if (mergeConflicts.length > 0) {
          conflicts.push(...mergeConflicts);
        }
      }

      // 5. Detect conflicts
      if (conflicts.length === 0 && (await this.hasLocalBranch())) {
        const statusAfter = await git.statusMatrix({ fs: this.fs, dir: this.dir });
        for (const [filepath, head, workdir, stage] of statusAfter) {
          if (stage === 2 || stage === 3 || (head === 0 && workdir === 2 && stage === 0)) {
            const ours = await this.readFileContent(filepath);
            const theirs = await this.readRemoteFileContent(filepath);
            conflicts.push({ path: filepath, ours, theirs });
          }
        }
      }

      // 6. Push local branch if zero conflicts
      if (conflicts.length === 0 && (await this.hasLocalBranch())) {
        await this.pushWithRecovery();
      }

      return { success: conflicts.length === 0, conflictFiles: conflicts };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, conflictFiles: [], error: msg };
    }
  }

  /** Resolve conflict and commit + push */
  async resolveConflict(filepath: string, resolvedContent: string): Promise<void> {
    const fullPath = `${this.dir}/${filepath}`;
    await this.fs.promises.writeFile(fullPath, resolvedContent);
    await git.add({ fs: this.fs, dir: this.dir, filepath });

    let parents: string[] | undefined;
    try {
      const localHead = await git.resolveRef({ fs: this.fs, dir: this.dir, ref: DEFAULT_BRANCH });
      parents =
        this.latestRemoteHead && this.latestRemoteHead !== localHead
          ? [localHead, this.latestRemoteHead]
          : [localHead];
    } catch {
      parents = undefined;
    }

    await git.commit({
      ...this.gitOpts(),
      parent: parents,
      message: `sync: resolve conflict in ${filepath}`,
    });
    await this.pushWithRecovery();
  }

  /** Pull only on vault startup, with automatic disk checkout */
  async pull(): Promise<ConflictFile[]> {
    if (!(await this.hasLocalBranch())) return [];

    const fetchHead = await this.safeFetch();
    if (!fetchHead) return [];

    return await this.reconcileRemote(fetchHead);
  }

  private async readFileContent(filepath: string): Promise<string> {
    try {
      const buf = await this.fs.promises.readFile(
        `${this.dir}/${filepath}`,
        { encoding: "utf8" }
      );
      return buf as string;
    } catch {
      return "";
    }
  }

  private async readRemoteFileContent(filepath: string): Promise<string> {
    try {
      let remoteCommit: string;
      try {
        remoteCommit = await git.resolveRef({
          fs: this.fs,
          dir: this.dir,
          ref: `refs/remotes/origin/${DEFAULT_BRANCH}`,
        });
      } catch {
        if (this.latestRemoteHead) {
          remoteCommit = this.latestRemoteHead;
        } else {
          return "";
        }
      }
      const { blob } = await git.readBlob({
        fs: this.fs,
        dir: this.dir,
        oid: remoteCommit,
        filepath,
      });
      return new TextDecoder().decode(blob);
    } catch {
      return "";
    }
  }
}

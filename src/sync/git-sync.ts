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
      await git.fetch({
        ...this.netOpts(),
        ref: DEFAULT_BRANCH,
        singleBranch: true,
      });
      return await git.resolveRef({ fs: this.fs, dir: this.dir, ref: "FETCH_HEAD" });
    } catch {
      return null;
    }
  }

  /** Clone remote into vault */
  async clone(): Promise<boolean> {
    await git.clone({
      ...this.netOpts(),
      singleBranch: true,
      depth: 1,
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

    await git.push({
      ...this.netOpts(),
      ref: DEFAULT_BRANCH,
      force: false,
    });
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
        const localHead = await git.resolveRef({
          fs: this.fs,
          dir: this.dir,
          ref: DEFAULT_BRANCH,
        });

        if (fetchHead !== localHead) {
          await git.merge({
            fs: this.fs,
            dir: this.dir,
            ours: DEFAULT_BRANCH,
            theirs: fetchHead,
            author: { name: this.authorName, email: this.authorEmail },
            message: "sync: merge remote changes",
            fastForwardOnly: false,
          });

          // Write updated remote files to physical disk (Issue #4 fix)
          await git.checkout({
            fs: this.fs,
            dir: this.dir,
            ref: DEFAULT_BRANCH,
            force: true,
          });
        }
      }

      // 5. Detect conflicts
      if (await this.hasLocalBranch()) {
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
        await git.push({
          ...this.netOpts(),
          ref: DEFAULT_BRANCH,
        });
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
    await git.commit({
      ...this.gitOpts(),
      message: `sync: resolve conflict in ${filepath}`,
    });
    await git.push({
      ...this.netOpts(),
      ref: DEFAULT_BRANCH,
    });
  }

  /** Pull only on vault startup, with automatic disk checkout */
  async pull(): Promise<void> {
    if (!(await this.hasLocalBranch())) return;

    const fetchHead = await this.safeFetch();
    if (!fetchHead) return;

    const localHead = await git.resolveRef({
      fs: this.fs,
      dir: this.dir,
      ref: DEFAULT_BRANCH,
    });

    if (fetchHead !== localHead) {
      await git.merge({
        fs: this.fs,
        dir: this.dir,
        ours: DEFAULT_BRANCH,
        theirs: fetchHead,
        author: { name: this.authorName, email: this.authorEmail },
        message: "sync: merge remote changes",
        fastForwardOnly: false,
      });

      // Checkout working tree so files appear updated on disk
      await git.checkout({
        fs: this.fs,
        dir: this.dir,
        ref: DEFAULT_BRANCH,
        force: true,
      });
    }
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
      const remoteCommit = await git.resolveRef({
        fs: this.fs,
        dir: this.dir,
        ref: `refs/remotes/origin/${DEFAULT_BRANCH}`,
      });
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

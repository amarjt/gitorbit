import { DataAdapter } from "obsidian";

type Stats = {
  type: "file" | "dir";
  mode: number;
  size: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
  uid: number;
  gid: number;
  dev: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
};

/**
 * Creates an fs-like adapter bridging Obsidian's DataAdapter to isomorphic-git.
 * Strips vault root prefix and normalizes paths across desktop and mobile.
 */
export function createFsAdapter(adapter: DataAdapter, vaultPath: string) {
  function rel(absPath: string): string {
    const normalized = absPath.replace(/\\/g, "/");
    const base = vaultPath.replace(/\\/g, "/").replace(/\/$/, "");
    if (base && normalized.startsWith(base + "/")) {
      return normalized.slice(base.length + 1);
    }
    return normalized.replace(/^\//, "");
  }

  const promises = {
    async readFile(path: string, options?: { encoding?: string }): Promise<Buffer | string> {
      try {
        const content = await adapter.readBinary(rel(path));
        if (options?.encoding === "utf8") {
          return Buffer.from(content).toString("utf8");
        }
        return Buffer.from(content);
      } catch {
        const err: NodeJS.ErrnoException = new Error(`ENOENT: no such file or directory, open '${path}'`);
        err.code = "ENOENT";
        throw err;
      }
    },

    async writeFile(path: string, data: string | Buffer | Uint8Array): Promise<void> {
      const relativePath = rel(path);
      const parts = relativePath.split("/");
      if (parts.length > 1) {
        const dir = parts.slice(0, -1).join("/");
        try {
          await adapter.mkdir(dir);
        } catch {
          // Parent directory already exists
        }
      }

      if (typeof data === "string") {
        await adapter.write(relativePath, data);
      } else {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        const arrayBuf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
        await adapter.writeBinary(relativePath, arrayBuf);
      }
    },

    async unlink(path: string): Promise<void> {
      try {
        await adapter.remove(rel(path));
      } catch {
        // Safe to ignore if already missing
      }
    },

    async readdir(path: string): Promise<string[]> {
      try {
        const result = await adapter.list(rel(path));
        const files = result.files.map((f) => f.split("/").pop()!);
        const folders = result.folders.map((f) => f.split("/").pop()!);
        return [...folders, ...files];
      } catch {
        const err: NodeJS.ErrnoException = new Error(`ENOENT: no such file or directory, scandir '${path}'`);
        err.code = "ENOENT";
        throw err;
      }
    },

    async mkdir(path: string, _options?: unknown): Promise<void> {
      try {
        await adapter.mkdir(rel(path));
      } catch {
        // Directory exists
      }
    },

    async rmdir(_path: string): Promise<void> {
      // isomorphic-git calls rmdir on cleanup
    },

    async stat(path: string): Promise<Stats> {
      try {
        const s = await adapter.stat(rel(path));
        if (!s) throw new Error("No stat");
        const isDir = s.type !== "file";
        return {
          type: isDir ? "dir" : "file",
          mode: isDir ? 0o040755 : 0o100644,
          size: s.size ?? 0,
          ino: 0,
          mtimeMs: s.mtime ?? Date.now(),
          ctimeMs: s.ctime ?? Date.now(),
          uid: 1,
          gid: 1,
          dev: 1,
          isFile: () => !isDir,
          isDirectory: () => isDir,
          isSymbolicLink: () => false,
        };
      } catch {
        const err: NodeJS.ErrnoException = new Error(`ENOENT: no such file or directory, stat '${path}'`);
        err.code = "ENOENT";
        throw err;
      }
    },

    async lstat(path: string): Promise<Stats> {
      return promises.stat(path);
    },

    async readlink(path: string): Promise<string> {
      throw Object.assign(new Error(`EINVAL: readlink not supported '${path}'`), { code: "EINVAL" });
    },

    async symlink(): Promise<void> {
      throw Object.assign(new Error("EINVAL: symlink not supported"), { code: "EINVAL" });
    },

    async chmod(): Promise<void> {
      // No-op for Obsidian virtual file system
    },
  };

  return { promises };
}

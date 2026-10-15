import { requestUrl, RequestUrlResponse, DataAdapter, DataWriteOptions, TFile, Vault, Platform } from "obsidian";
import { ApiSyncBaseline, ConflictFile, ISyncEngine, SyncResult, GitVaultSyncSettings, RepairResult } from "../types";
import { GITHUB_API_BASE } from "../constants";

const REQUEST_TIMEOUT_MS = 60_000;
const PROGRESS_EVERY = 25;
const NATIVE_HASH_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Yield a macrotask back to the event loop so V8 on Android WebView / iOS
 * can run GC and free ArrayBuffers allocated during file reads and hashing.
 */
export function yieldToGc(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

function getHeaders(token: string, accept?: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: accept || "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "GitOrbit",
  };
}

async function apiGetResponse(
  url: string,
  token: string,
  accept?: string
): Promise<RequestUrlResponse> {
  let timer: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => {
      reject(new Error(`GitOrbit: Request timed out after ${REQUEST_TIMEOUT_MS}ms`));
    }, REQUEST_TIMEOUT_MS);
  });

  let res: RequestUrlResponse;
  try {
    res = await Promise.race([
      requestUrl({
        url,
        method: "GET",
        headers: getHeaders(token, accept),
        throw: false,
      }),
      timeout,
    ]);
  } catch (err) {
    throw new Error(`GitOrbit network failure: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    if (timer) window.clearTimeout(timer);
  }

  if (!res.status) {
    throw new Error("GitOrbit network failure: offline or unable to connect to GitHub.");
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error("GitOrbit: Bad or expired GitHub token, or API rate limit exceeded.");
  }
  if (res.status === 404) {
    throw new Error("GitOrbit: Resource not found on GitHub (404).");
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`GitOrbit GitHub API error (${res.status}).`);
  }

  return res;
}

async function apiGet<T = unknown>(url: string, token: string): Promise<T> {
  const res = await apiGetResponse(url, token);
  return res.json as T;
}

async function apiWrite<T = unknown>(
  url: string,
  method: "POST" | "PATCH",
  body: unknown,
  token: string
): Promise<T> {
  let timer: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => {
      reject(new Error(`GitOrbit: Request timed out after ${REQUEST_TIMEOUT_MS}ms`));
    }, REQUEST_TIMEOUT_MS);
  });

  let res: RequestUrlResponse;
  try {
    res = await Promise.race([
      requestUrl({
        url,
        method,
        headers: {
          ...getHeaders(token),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        throw: false,
      }),
      timeout,
    ]);
  } catch (err) {
    throw new Error(`GitOrbit network failure: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    if (timer) window.clearTimeout(timer);
  }

  if (!res.status) {
    throw new Error("GitOrbit network failure: offline or unable to connect to GitHub.");
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error("GitOrbit: Bad or expired GitHub token, or API rate limit exceeded.");
  }
  if (res.status === 404) {
    throw new Error("GitOrbit: Resource not found on GitHub (404).");
  }
  if (res.status < 200 || res.status >= 300) {
    const errObj = res.json as { message?: string } | undefined;
    throw new Error(`GitOrbit GitHub API error (${res.status}): ${errObj?.message ?? "Request failed"}`);
  }

  return res.json as T;
}

export async function getBranchHead(
  owner: string,
  repo: string,
  branch: string,
  token: string
): Promise<{ commitSha: string; treeSha: string }> {
  const ref = await apiGet<{ object?: { sha?: string } }>(
    `${GITHUB_API_BASE}/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
    token
  );
  const commitSha = ref?.object?.sha;
  if (!commitSha) {
    throw new Error(`GitOrbit: Branch ${branch} not found.`);
  }

  const commit = await apiGet<{ tree?: { sha?: string } }>(
    `${GITHUB_API_BASE}/repos/${owner}/${repo}/git/commits/${commitSha}`,
    token
  );
  const treeSha = commit?.tree?.sha;
  if (!treeSha) {
    throw new Error(`GitOrbit: Root tree for commit ${commitSha} not found.`);
  }

  return { commitSha, treeSha };
}

export interface TreeBlobEntry {
  path: string;
  sha: string;
  size: number;
  mode: string;
}

export async function getTree(
  owner: string,
  repo: string,
  treeSha: string,
  token: string
): Promise<{ entries: TreeBlobEntry[]; truncated: boolean }> {
  const data = await apiGet<{
    tree?: Array<{ type?: string; path?: string; sha?: string; size?: number; mode?: string }>;
    truncated?: boolean;
  }>(`${GITHUB_API_BASE}/repos/${owner}/${repo}/git/trees/${treeSha}?recursive=1`, token);

  const truncated = data.truncated === true;
  const entries: TreeBlobEntry[] = [];

  if (Array.isArray(data.tree)) {
    for (const e of data.tree) {
      if (e.type !== "blob" || !e.path || !e.sha) continue;
      entries.push({
        path: e.path,
        sha: e.sha,
        size: typeof e.size === "number" ? e.size : 0,
        mode: e.mode || "100644",
      });
    }
  }

  return { entries, truncated };
}

export async function getBlob(
  owner: string,
  repo: string,
  blobSha: string,
  token: string
): Promise<Uint8Array> {
  const res = await apiGetResponse(
    `${GITHUB_API_BASE}/repos/${owner}/${repo}/git/blobs/${blobSha}`,
    token,
    "application/vnd.github.raw"
  );

  const contentType = (
    res.headers?.["content-type"] ??
    res.headers?.["Content-Type"] ??
    ""
  ).toLowerCase();

  // Raw path: response body is binary arrayBuffer
  if (!contentType.includes("json")) {
    return new Uint8Array(res.arrayBuffer);
  }

  // Fallback if GitHub server didn't honor raw header: decode base64
  const data = res.json as { content?: string; encoding?: string };
  if (data?.encoding === "base64" && typeof data.content === "string") {
    return base64ToBytes(data.content);
  }

  throw new Error("GitOrbit: Unable to read blob data from GitHub.");
}

function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/\s+/g, "");
  const binary = atob(clean);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  const CHUNK = 3 * 16384; // 49152: multiple of 3 to avoid interior padding
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const sub = bytes.subarray(i, i + CHUNK);
    out += btoa(String.fromCharCode.apply(null, sub as unknown as number[]));
  }
  return out;
}

export async function createBlob(
  owner: string,
  repo: string,
  token: string,
  content: Uint8Array
): Promise<string> {
  const data = await apiWrite<{ sha?: string }>(
    `${GITHUB_API_BASE}/repos/${owner}/${repo}/git/blobs`,
    "POST",
    { content: bytesToBase64(content), encoding: "base64" },
    token
  );
  if (!data?.sha) throw new Error("GitOrbit: Failed to create blob on GitHub.");
  return data.sha;
}

export interface TreeEntryInput {
  path: string;
  sha: string | null; // null deletes path
  mode?: string;
}

export async function createTree(
  owner: string,
  repo: string,
  token: string,
  baseTreeSha: string | null,
  entries: TreeEntryInput[]
): Promise<string> {
  const tree = entries.map((e) => ({
    path: e.path,
    mode: e.mode ?? "100644",
    type: "blob",
    sha: e.sha,
  }));

  const body: { tree: typeof tree; base_tree?: string } = { tree };
  if (baseTreeSha) {
    body.base_tree = baseTreeSha;
  }

  const data = await apiWrite<{ sha?: string }>(
    `${GITHUB_API_BASE}/repos/${owner}/${repo}/git/trees`,
    "POST",
    body,
    token
  );
  if (!data?.sha) throw new Error("GitOrbit: Failed to create git tree on GitHub.");
  return data.sha;
}

export async function createCommit(
  owner: string,
  repo: string,
  token: string,
  message: string,
  treeSha: string,
  parents: string[]
): Promise<string> {
  const data = await apiWrite<{ sha?: string }>(
    `${GITHUB_API_BASE}/repos/${owner}/${repo}/git/commits`,
    "POST",
    { message, tree: treeSha, parents },
    token
  );
  if (!data?.sha) throw new Error("GitOrbit: Failed to create commit on GitHub.");
  return data.sha;
}

export async function updateRef(
  owner: string,
  repo: string,
  token: string,
  branch: string,
  commitSha: string,
  force = false
): Promise<void> {
  await apiWrite(
    `${GITHUB_API_BASE}/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`,
    "PATCH",
    { sha: commitSha, force },
    token
  );
}

export async function createRef(
  owner: string,
  repo: string,
  token: string,
  branch: string,
  commitSha: string
): Promise<void> {
  await apiWrite(
    `${GITHUB_API_BASE}/repos/${owner}/${repo}/git/refs`,
    "POST",
    { ref: `refs/heads/${branch}`, sha: commitSha },
    token
  );
}

// ── SHA-1 Blob Hashing ──────────────────────────────────────────────────────

const STRICT_TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });

export function decodeTextOrNull(bytes: Uint8Array): string | null {
  try {
    const text = STRICT_TEXT_DECODER.decode(bytes);
    return text.includes("\u0000") ? null : text;
  } catch {
    return null;
  }
}

export async function gitBlobSha(content: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`blob ${content.length}\0`);

  if (content.length <= NATIVE_HASH_MAX_BYTES) {
    const payload = new Uint8Array(header.length + content.length);
    payload.set(header, 0);
    payload.set(content, header.length);
    const digest = await crypto.subtle.digest("SHA-1", payload);
    return bytesToHex(new Uint8Array(digest));
  }

  // Streaming JS SHA-1 for large files (>2MB) to prevent WebView OOM
  const sha = new StreamingSha1();
  sha.update(header);
  const CHUNK = 1 << 20; // 1 MB
  for (let i = 0; i < content.length; i += CHUNK) {
    sha.update(content.subarray(i, i + CHUNK));
  }
  return sha.hex();
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

class StreamingSha1 {
  private h0 = 0x67452301;
  private h1 = 0xefcdab89;
  private h2 = 0x98badcfe;
  private h3 = 0x10325476;
  private h4 = 0xc3d2e1f0;
  private readonly block = new Uint8Array(64);
  private blockLen = 0;
  private totalLen = 0;
  private readonly w = new Uint32Array(80);

  update(bytes: Uint8Array): void {
    this.totalLen += bytes.length;
    let offset = 0;
    if (this.blockLen > 0) {
      while (offset < bytes.length && this.blockLen < 64) {
        this.block[this.blockLen++] = bytes[offset++];
      }
      if (this.blockLen === 64) {
        this.process(this.block, 0);
        this.blockLen = 0;
      }
    }
    while (bytes.length - offset >= 64) {
      this.process(bytes, offset);
      offset += 64;
    }
    while (offset < bytes.length) {
      this.block[this.blockLen++] = bytes[offset++];
    }
  }

  hex(): string {
    const bitLenHi = Math.floor(this.totalLen / 0x20000000);
    const bitLenLo = (this.totalLen * 8) >>> 0;
    const pad: number[] = [0x80];
    while ((this.totalLen + pad.length) % 64 !== 56) pad.push(0);
    pad.push(
      (bitLenHi >>> 24) & 0xff,
      (bitLenHi >>> 16) & 0xff,
      (bitLenHi >>> 8) & 0xff,
      bitLenHi & 0xff
    );
    pad.push(
      (bitLenLo >>> 24) & 0xff,
      (bitLenLo >>> 16) & 0xff,
      (bitLenLo >>> 8) & 0xff,
      bitLenLo & 0xff
    );
    this.update(new Uint8Array(pad));

    const out = [this.h0, this.h1, this.h2, this.h3, this.h4];
    let hex = "";
    for (const v of out) hex += (v >>> 0).toString(16).padStart(8, "0");
    return hex;
  }

  private process(data: Uint8Array, off: number): void {
    const w = this.w;
    for (let i = 0; i < 16; i++) {
      w[i] =
        (data[off + i * 4] << 24) |
        (data[off + i * 4 + 1] << 16) |
        (data[off + i * 4 + 2] << 8) |
        data[off + i * 4 + 3];
    }
    for (let i = 16; i < 80; i++) {
      const n = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
      w[i] = (n << 1) | (n >>> 31);
    }
    let a = this.h0,
      b = this.h1,
      c = this.h2,
      d = this.h3,
      e = this.h4;
    for (let i = 0; i < 80; i++) {
      let f: number, k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const tmp = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) | 0;
      e = d;
      d = c;
      c = (b << 30) | (b >>> 2);
      b = a;
      a = tmp;
    }
    this.h0 = (this.h0 + a) | 0;
    this.h1 = (this.h1 + b) | 0;
    this.h2 = (this.h2 + c) | 0;
    this.h3 = (this.h3 + d) | 0;
    this.h4 = (this.h4 + e) | 0;
  }
}

// ── Obsidian File Adapters ──────────────────────────────────────────────────

/**
 * Creates a DataAdapter proxy that writes through Obsidian's Vault API for
 * open notes/files (triggering live editor updates and metadata cache sync),
 * while falling back to direct DataAdapter for new files or non-TFiles.
 */
export function createSyncAdapter(vault: Vault): DataAdapter {
  const adapter = vault.adapter;
  const writes = {
    async write(path: string, data: string, options?: DataWriteOptions) {
      const file = vault.getAbstractFileByPath(path);
      if (file instanceof TFile) await vault.modify(file, data, options);
      else await adapter.write(path, data, options);
    },
    async writeBinary(path: string, data: ArrayBuffer, options?: DataWriteOptions) {
      const file = vault.getAbstractFileByPath(path);
      if (file instanceof TFile) await vault.modifyBinary(file, data, options);
      else await adapter.writeBinary(path, data, options);
    },
    async remove(path: string) {
      const file = vault.getAbstractFileByPath(path);
      if (file instanceof TFile) await vault.delete(file);
      else await adapter.remove(path);
    },
  };
  return new Proxy(adapter, {
    get(target, key) {
      if (key === "write" || key === "writeBinary" || key === "remove") {
        return writes[key as keyof typeof writes];
      }
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export async function writeVaultFile(
  adapter: DataAdapter,
  path: string,
  bytes: Uint8Array
): Promise<void> {
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  if (dir && !(await adapter.exists(dir))) {
    const segs = dir.split("/");
    let prefix = "";
    for (const seg of segs) {
      if (!seg) continue;
      prefix = prefix ? `${prefix}/${seg}` : seg;
      if (!(await adapter.exists(prefix))) {
        try {
          await adapter.mkdir(prefix);
        } catch {
          // Already exists
        }
      }
    }
  }

  const text = decodeTextOrNull(bytes);
  if (text === null) {
    await adapter.writeBinary(path, new Uint8Array(bytes).buffer);
  } else {
    await adapter.write(path, text);
  }
}

export async function removeVaultFile(adapter: DataAdapter, path: string): Promise<void> {
  if (await adapter.exists(path)) {
    await adapter.remove(path);
  }
  const segments = path.split("/");
  segments.pop();
  while (segments.length > 0) {
    if (segments.some((segment) => segment.startsWith("."))) return;
    const parent = segments.join("/");
    if (!(await adapter.exists(parent))) {
      segments.pop();
      continue;
    }
    const listing = await adapter.list(parent);
    if (listing.files.length || listing.folders.length) return;
    await adapter.rmdir(parent, false);
    segments.pop();
  }
}

async function listVaultFiles(
  adapter: DataAdapter,
  dir: string,
  excluded: (path: string) => boolean,
  out: string[]
): Promise<void> {
  const listing = await adapter.list(dir === "" ? "/" : dir);
  for (const file of listing.files) {
    const p = file.replace(/^\/+/, "");
    if (!p || excluded(p)) continue;
    out.push(p);
  }
  for (const folder of listing.folders) {
    const f = folder.replace(/^\/+/, "");
    if (!f) continue;
    if (f === ".git" || excluded(f) || excluded(`${f}/`)) continue;
    await listVaultFiles(adapter, f, excluded, out);
  }
}

async function scanLocalShas(
  adapter: DataAdapter,
  excluded: (path: string) => boolean,
  onProgress?: (msg: string) => void
): Promise<Record<string, string>> {
  const paths: string[] = [];
  await listVaultFiles(adapter, "", excluded, paths);

  const shas: Record<string, string> = {};
  let i = 0;
  for (const p of paths) {
    const buf = await adapter.readBinary(p);
    let bytes: Uint8Array | undefined = new Uint8Array(buf);
    shas[p] = await gitBlobSha(bytes);
    bytes = undefined;
    i++;
    if (i % PROGRESS_EVERY === 0) {
      onProgress?.(`Scanning vault files (${i}/${paths.length})…`);
      await yieldToGc();
    }
  }
  return shas;
}

function diffShas(
  current: Record<string, string>,
  baseline: Record<string, string>
): { changed: Set<string>; deleted: Set<string> } {
  const changed = new Set<string>();
  const deleted = new Set<string>();
  for (const [p, sha] of Object.entries(current)) {
    if (baseline[p] !== sha) changed.add(p);
  }
  for (const p of Object.keys(baseline)) {
    if (!(p in current)) deleted.add(p);
  }
  return { changed, deleted };
}

// ── GitHub Git Data API Sync Engine ─────────────────────────────────────────

export class GitHubApiSync implements ISyncEngine {
  private vault: Vault;
  private adapter: DataAdapter;
  private token: string;
  private owner: string;
  private repo: string;
  private branch: string;
  private getSettings: () => GitVaultSyncSettings;
  private saveSettings: () => Promise<void>;
  private onProgress?: (msg: string) => void;

  constructor(
    vault: Vault,
    token: string,
    owner: string,
    repo: string,
    branch: string,
    getSettings: () => GitVaultSyncSettings,
    saveSettings: () => Promise<void>,
    onProgress?: (msg: string) => void
  ) {
    this.vault = vault;
    this.adapter = createSyncAdapter(vault);
    this.token = token;
    this.owner = owner;
    this.repo = repo;
    this.branch = branch || "main";
    this.getSettings = getSettings;
    this.saveSettings = saveSettings;
    this.onProgress = onProgress;
  }

  async isInitialized(): Promise<boolean> {
    try {
      await getBranchHead(this.owner, this.repo, this.branch, this.token);
      return true;
    } catch {
      return false;
    }
  }

  async initAndPush(files: string[]): Promise<void> {
    const treeEntries: TreeEntryInput[] = [];
    const newShas: Record<string, string> = {};

    let count = 0;
    for (const p of files) {
      if (this.isExcluded(p)) continue;
      const buf = await this.adapter.readBinary(p);
      let bytes: Uint8Array | undefined = new Uint8Array(buf);
      const sha = await createBlob(this.owner, this.repo, this.token, bytes);
      bytes = undefined;
      treeEntries.push({ path: p, sha, mode: "100644" });
      newShas[p] = sha;
      count++;
      if (count % PROGRESS_EVERY === 0) {
        this.onProgress?.(`Uploading files (${count}/${files.length})…`);
        await yieldToGc();
      }
    }

    const treeSha = await createTree(this.owner, this.repo, this.token, null, treeEntries);
    const commitSha = await createCommit(
      this.owner,
      this.repo,
      this.token,
      "Initial vault sync via GitOrbit",
      treeSha,
      []
    );

    // Create branch ref
    await createRef(this.owner, this.repo, this.token, this.branch, commitSha);

    // Set baseline
    const settings = this.getSettings();
    settings.apiBaseline = { commitSha, shas: newShas };
    await this.saveSettings();
  }

  async pull(): Promise<ConflictFile[]> {
    const result = await this.sync();
    return result.conflictFiles;
  }

  async sync(_filesToSync?: string[]): Promise<SyncResult> {
    try {
      this.onProgress?.("Connecting to GitHub…");
      const { commitSha: remoteCommit, treeSha: remoteTree } = await getBranchHead(
        this.owner,
        this.repo,
        this.branch,
        this.token
      );

      this.onProgress?.("Fetching remote tree…");
      const { entries, truncated } = await getTree(this.owner, this.repo, remoteTree, this.token);
      if (truncated) {
        throw new Error("GitOrbit: Remote repository tree was truncated by GitHub. Repository too large.");
      }

      const remoteShas: Record<string, string> = {};
      const remoteModes: Record<string, string> = {};
      for (const e of entries) {
        if (!e.path || this.isExcluded(e.path)) continue;
        remoteShas[e.path] = e.sha;
        remoteModes[e.path] = e.mode;
      }

      this.onProgress?.("Scanning local files…");
      const localShas = await scanLocalShas(
        this.adapter,
        (p) => this.isExcluded(p),
        this.onProgress
      );

      const baseline = this.getSettings().apiBaseline || { commitSha: null, shas: {} };

      // 3. Diff against baseline
      const local = diffShas(localShas, baseline.shas);
      const remote = diffShas(remoteShas, baseline.shas);

      // 4. Identify conflicts
      const conflictPaths = new Set<string>();
      const touchedLocal = new Set<string>([...local.changed, ...local.deleted]);
      const touchedRemote = new Set<string>([...remote.changed, ...remote.deleted]);

      for (const p of touchedLocal) {
        if (!touchedRemote.has(p)) continue;
        const lSha = localShas[p];
        const rSha = remoteShas[p];
        if (lSha !== rSha) {
          conflictPaths.add(p);
        }
      }

      // If conflicts exist, collect ConflictFile[] for UI resolution
      if (conflictPaths.size > 0) {
        const conflicts: ConflictFile[] = [];
        for (const p of conflictPaths) {
          let ours = "";
          let theirs = "";

          if (localShas[p]) {
            try {
              const b = await this.adapter.readBinary(p);
              ours = decodeTextOrNull(new Uint8Array(b)) ?? "[Binary file]";
            } catch {
              ours = "[Deleted locally]";
            }
          }

          if (remoteShas[p]) {
            try {
              const b = await getBlob(this.owner, this.repo, remoteShas[p], this.token);
              theirs = decodeTextOrNull(b) ?? "[Binary file]";
            } catch {
              theirs = "[Error reading remote]";
            }
          }

          conflicts.push({ path: p, ours, theirs });
        }

        return {
          success: false,
          conflictFiles: conflicts,
          error: `${conflicts.length} conflict(s) detected.`,
        };
      }

      // 5. Pull non-conflict remote changes
      const toPull = [...remote.changed].filter((p) => !conflictPaths.has(p)).sort();
      const toDeleteLocal = [...remote.deleted].filter((p) => !conflictPaths.has(p)).sort();

      let pullCount = 0;
      for (const p of toPull) {
        if (localShas[p] === remoteShas[p]) continue;
        this.onProgress?.(`Pulling ${p}…`);
        let bytes: Uint8Array | undefined = await getBlob(
          this.owner,
          this.repo,
          remoteShas[p],
          this.token
        );
        await writeVaultFile(this.adapter, p, bytes);
        bytes = undefined;
        pullCount++;
        if (pullCount % PROGRESS_EVERY === 0) {
          await yieldToGc();
        }
      }

      for (const p of toDeleteLocal) {
        await removeVaultFile(this.adapter, p);
      }

      // 6. Push non-conflict local changes
      const toPush = [...local.changed].filter((p) => !conflictPaths.has(p)).sort();
      const toDeleteRemote = [...local.deleted].filter((p) => !conflictPaths.has(p)).sort();

      const realPush = toPush.filter((p) => remoteShas[p] !== localShas[p]);
      const realDeleteRemote = toDeleteRemote.filter((p) => p in remoteShas);

      let newCommit = remoteCommit;
      if (realPush.length > 0 || realDeleteRemote.length > 0) {
        this.onProgress?.("Uploading changes…");
        const treeEntries: TreeEntryInput[] = [];
        let pushCount = 0;
        for (const p of realPush) {
          const buf = await this.adapter.readBinary(p);
          let bytes: Uint8Array | undefined = new Uint8Array(buf);
          const sha = await createBlob(this.owner, this.repo, this.token, bytes);
          bytes = undefined;
          treeEntries.push({ path: p, sha, mode: remoteModes[p] || "100644" });
          pushCount++;
          if (pushCount % PROGRESS_EVERY === 0) {
            this.onProgress?.(`Uploaded (${pushCount}/${realPush.length})…`);
            await yieldToGc();
          }
        }

        for (const p of realDeleteRemote) {
          treeEntries.push({ path: p, sha: null });
        }

        const newTree = await createTree(
          this.owner,
          this.repo,
          this.token,
          remoteTree,
          treeEntries
        );

        const settings = this.getSettings();
        const msgTemplate = settings.commitMessageTemplate || "sync: {{datetime}}";
        const message = msgTemplate.replace("{{datetime}}", new Date().toISOString());

        newCommit = await createCommit(
          this.owner,
          this.repo,
          this.token,
          message,
          newTree,
          [remoteCommit]
        );

        await updateRef(this.owner, this.repo, this.token, this.branch, newCommit, false);
      }

      // 7. Update baseline
      const nb: Record<string, string> = { ...remoteShas };
      for (const p of toDeleteLocal) delete nb[p];
      for (const p of realPush) nb[p] = localShas[p];
      for (const p of realDeleteRemote) delete nb[p];

      const settings = this.getSettings();
      settings.apiBaseline = { commitSha: newCommit, shas: nb };
      await this.saveSettings();

      return { success: true, conflictFiles: [] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, conflictFiles: [], error: msg };
    }
  }

  async resolveConflict(filepath: string, resolvedContent: string): Promise<void> {
    // 1. Write to local vault
    const bytes = new TextEncoder().encode(resolvedContent);
    await writeVaultFile(this.adapter, filepath, bytes);

    // 2. Fetch live remote tip
    const { commitSha: remoteCommit, treeSha: remoteTree } = await getBranchHead(
      this.owner,
      this.repo,
      this.branch,
      this.token
    );

    // 3. Upload resolved blob
    const sha = await createBlob(this.owner, this.repo, this.token, bytes);
    const newTree = await createTree(this.owner, this.repo, this.token, remoteTree, [
      { path: filepath, sha, mode: "100644" },
    ]);

    const newCommit = await createCommit(
      this.owner,
      this.repo,
      this.token,
      `Resolve conflict: ${filepath}`,
      newTree,
      [remoteCommit]
    );

    await updateRef(this.owner, this.repo, this.token, this.branch, newCommit, false);

    // 4. Update baseline
    const settings = this.getSettings();
    if (!settings.apiBaseline) {
      settings.apiBaseline = { commitSha: newCommit, shas: {} };
    }
    settings.apiBaseline.commitSha = newCommit;
    settings.apiBaseline.shas[filepath] = sha;
    await this.saveSettings();
  }

  async repairGitRepository(): Promise<RepairResult> {
    // For GitHub API engine, reset baseline to force clean re-sync
    const settings = this.getSettings();
    settings.apiBaseline = { commitSha: null, shas: {} };
    await this.saveSettings();
    return { repaired: true, cleanedCount: 1, details: ["Reset API baseline to force clean re-sync"], errors: [] };
  }

  private isExcluded(p: string): boolean {
    const path = p.replace(/^\/+/, "");
    if (!path) return true;

    // Hardcoded exclusions
    if (path === ".git" || path.startsWith(".git/")) return true;

    // Config directory (.obsidian) is always skipped by API engine on mobile to prevent OOM
    const configDir = this.vault.configDir || ".obsidian";
    if (path === configDir || path.startsWith(`${configDir}/`)) return true;

    // Data json with secret token
    if (path.includes("gitorbit/data.json")) return true;

    // User exclusions
    const settings = this.getSettings();
    return (settings.excludePatterns || []).some((pattern) => {
      const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      const regexStr = escaped.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*");
      return new RegExp(`^${regexStr}$`).test(path);
    });
  }
}

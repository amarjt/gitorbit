import {
  DEFAULT_CLIENT_ID,
  DEFAULT_AUTHOR_NAME,
  DEFAULT_AUTHOR_EMAIL,
  DEFAULT_SYNC_DEBOUNCE_MS,
} from "./constants";

export interface GitVaultSyncSettings {
  authType: "oauth" | "pat";
  githubToken: string;           // GitHub token (OAuth access token or PAT, stored locally in data.json)
  githubUsername: string;        // Authenticated GitHub username
  clientId: string;              // OAuth Client ID (user customizable or default)
  repoName: string;              // Remote repository name (e.g. "obsidian-my-vault")
  autoSync: boolean;             // Automatically sync on vault file changes
  syncIntervalMs: number;        // Debounce window in milliseconds
  excludePatterns: string[];     // Glob patterns to exclude
  lastSyncTime: number;          // Unix timestamp of last successful sync
  commitMessageTemplate: string; // Commit message template
  authorName: string;            // Git commit author name
  authorEmail: string;           // Git commit author email
}

export const DEFAULT_SETTINGS: GitVaultSyncSettings = {
  authType: "oauth",
  githubToken: "",
  githubUsername: "",
  clientId: DEFAULT_CLIENT_ID,
  repoName: "",
  autoSync: true,
  syncIntervalMs: DEFAULT_SYNC_DEBOUNCE_MS,
  excludePatterns: [
    ".obsidian/workspace",
    ".obsidian/workspace.json",
    ".obsidian/workspace-mobile.json",
    ".obsidian/plugins/*/data.json",
    ".git/**",
  ],
  lastSyncTime: 0,
  commitMessageTemplate: "sync: {{datetime}}",
  authorName: DEFAULT_AUTHOR_NAME,
  authorEmail: DEFAULT_AUTHOR_EMAIL,
};

export interface DeviceFlowResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export interface GitHubUser {
  login: string;
  id: number;
  name?: string;
  email?: string;
}

export interface GitHubRepo {
  name: string;
  full_name: string;
  private: boolean;
  clone_url: string;
  html_url: string;
}

export type SyncStatus =
  | "idle"
  | "pulling"
  | "pushing"
  | "conflict"
  | "error"
  | "connecting";

export interface ConflictFile {
  path: string;
  ours: string;   // Local file content
  theirs: string; // Remote file content
}

export interface SyncResult {
  success: boolean;
  conflictFiles: ConflictFile[];
  error?: string;
}

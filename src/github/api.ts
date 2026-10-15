import { requestUrl } from "obsidian";
import { GITHUB_API_BASE } from "../constants";
import { GitHubUser, GitHubRepo } from "../types";

async function ghFetch<T>(
  path: string,
  token: string,
  options: { method?: string; body?: object } = {}
): Promise<T> {
  const response = await requestUrl({
    url: `${GITHUB_API_BASE}${path}`,
    method: options.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    throw: false,
  });

  if (response.status >= 400) {
    const err = response.json as { message?: string } | undefined;
    throw new Error(`GitHub API error (${response.status}): ${err?.message ?? "Request failed"}`);
  }

  return response.json as T;
}

/** Get authenticated GitHub user details */
export async function getAuthenticatedUser(token: string): Promise<GitHubUser> {
  return ghFetch<GitHubUser>("/user", token);
}

/** Check if a repository exists under the target user */
export async function repoExists(
  token: string,
  username: string,
  repoName: string
): Promise<boolean> {
  const response = await requestUrl({
    url: `${GITHUB_API_BASE}/repos/${username}/${repoName}`,
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
    },
    throw: false,
  });
  return response.status === 200;
}

/** Create a new private repository for this vault */
export async function createRepo(
  token: string,
  repoName: string,
  description: string
): Promise<GitHubRepo> {
  return ghFetch<GitHubRepo>("/user/repos", token, {
    method: "POST",
    body: {
      name: repoName,
      description,
      private: true,
      auto_init: false,
    },
  });
}

/** Derive a safe repository name from the Obsidian vault name */
export function vaultNameToRepoName(vaultName: string): string {
  const sanitized = vaultName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `obsidian-${sanitized || "vault"}`;
}

/**
 * Fetch all repositories accessible to the user (owned, collaborator, organization member).
 */
export async function fetchUserRepos(token: string): Promise<GitHubRepo[]> {
  try {
    const repos = await ghFetch<Array<{
      name?: string;
      full_name?: string;
      private?: boolean;
      clone_url?: string;
      html_url?: string;
    }>>("/user/repos?per_page=100&sort=pushed&direction=desc&affiliation=owner,collaborator,organization_member", token);

    if (!Array.isArray(repos)) return [];
    return repos.map((r) => ({
      name: r.name || "",
      full_name: r.full_name || "",
      private: r.private === true,
      clone_url: r.clone_url || "",
      html_url: r.html_url || "",
    }));
  } catch (err) {
    console.warn("GitOrbit: Failed to list user repos:", err);
    return [];
  }
}

/**
 * Parses owner and repo name from a GitHub clone URL or path.
 * Supports:
 * - https://github.com/owner/repo.git
 * - https://github.com/owner/repo
 * - github.com/owner/repo
 * - owner/repo
 */
export function parseGitHubRepo(url: string): { owner: string; repo: string } | null {
  const trimmed = url.trim();
  if (!trimmed) return null;

  // Match full https/http URL
  const urlMatch = trimmed.match(/^https?:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (urlMatch && urlMatch[1] && urlMatch[2]) {
    return { owner: urlMatch[1], repo: urlMatch[2] };
  }

  // Match owner/repo
  const slashMatch = trimmed.match(/^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?$/);
  if (slashMatch && slashMatch[1] && slashMatch[2] && !trimmed.startsWith("http")) {
    return { owner: slashMatch[1], repo: slashMatch[2] };
  }

  return null;
}

/**
 * Format standard HTTPS clone URL for a repository
 */
export function formatRemoteUrl(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}.git`;
}

/**
 * Non-blocking sanity check for a remote URL. Returns an informative hint or null.
 */
export function remoteUrlHint(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  if (/^[\w.-]+@[\w.-]+:/.test(trimmed) || trimmed.startsWith("ssh://")) {
    return "SSH remote URLs are not supported by the pure-JS engine. Please use an HTTPS URL.";
  }
  if (!parseGitHubRepo(trimmed)) {
    return "Expected an HTTPS GitHub URL (e.g. https://github.com/owner/repo.git) or owner/repo format.";
  }
  return null;
}

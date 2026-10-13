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

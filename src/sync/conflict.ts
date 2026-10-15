import { ConflictFile } from "../types";

export interface DiffItem {
  type: "common" | "ours" | "theirs";
  text: string;
}

/**
 * Compute Longest Common Subsequence (LCS) diff between two line arrays.
 * Caps at 250,000 matrix cells to prevent memory spikes on extreme inputs.
 */
export function computeLcs(a: string[], b: string[]): DiffItem[] {
  const m = a.length;
  const n = b.length;

  // Fallback for unusually large slices
  if (m * n > 250000) {
    const setA = new Set(a);
    const added = b.filter((line) => !setA.has(line));
    return [
      ...a.map((text) => ({ type: "ours" as const, text })),
      ...added.map((text) => ({ type: "theirs" as const, text })),
    ];
  }

  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) {
      if (a[i] === b[j]) {
        dp[i + 1][j + 1] = dp[i][j] + 1;
      } else {
        dp[i + 1][j + 1] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  let i = m;
  let j = n;
  const result: DiffItem[] = [];
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      result.push({ type: "common", text: a[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.push({ type: "theirs", text: b[j - 1] });
      j--;
    } else if (i > 0 && (j === 0 || dp[i][j - 1] < dp[i - 1][j])) {
      result.push({ type: "ours", text: a[i - 1] });
      i--;
    }
  }

  return result.reverse();
}

/**
 * Extract only the extra lines present in `theirs` that do not exist in `ours`.
 */
export function extractExtraLines(ours: string, theirs: string): string[] {
  if (!theirs) return [];
  if (!ours) return theirs.split(/\r?\n/);
  if (ours === theirs) return [];

  const linesA = ours.split(/\r?\n/);
  const linesB = theirs.split(/\r?\n/);

  let start = 0;
  while (start < linesA.length && start < linesB.length && linesA[start] === linesB[start]) {
    start++;
  }

  let endA = linesA.length - 1;
  let endB = linesB.length - 1;
  while (endA >= start && endB >= start && linesA[endA] === linesB[endB]) {
    endA--;
    endB--;
  }

  const midA = linesA.slice(start, endA + 1);
  const midB = linesB.slice(start, endB + 1);

  if (midB.length === 0) return [];
  if (midA.length === 0) return midB;

  const diff = computeLcs(midA, midB);
  return diff.filter((d) => d.type === "theirs").map((d) => d.text);
}

/**
 * Merges local ('ours') and remote ('theirs') by adding ONLY the extra/differing
 * content from remote without duplicating common headers, paragraphs, or structure.
 */
export function mergeExtraContents(ours: string, theirs: string): string {
  if (!theirs) return ours;
  if (!ours) return theirs;
  if (ours === theirs) return ours;

  const linesA = ours.split(/\r?\n/);
  const linesB = theirs.split(/\r?\n/);

  // 1. Trim common prefix lines
  let start = 0;
  while (start < linesA.length && start < linesB.length && linesA[start] === linesB[start]) {
    start++;
  }

  // 2. Trim common suffix lines
  let endA = linesA.length - 1;
  let endB = linesB.length - 1;
  while (endA >= start && endB >= start && linesA[endA] === linesB[endB]) {
    endA--;
    endB--;
  }

  const prefix = linesA.slice(0, start);
  const suffix = linesA.slice(endA + 1);

  const midA = linesA.slice(start, endA + 1);
  const midB = linesB.slice(start, endB + 1);

  // If remote has no middle content, ours already contains everything
  if (midB.length === 0) {
    return ours;
  }

  // If ours has no middle content, remote just added these extra lines
  if (midA.length === 0) {
    return [...prefix, ...midB, ...suffix].join("\n");
  }

  // Both have differing middle lines: align via LCS
  const diff = computeLcs(midA, midB);
  const mergedMid: string[] = [];

  for (const item of diff) {
    if (item.type === "common" || item.type === "ours") {
      mergedMid.push(item.text);
    } else if (item.type === "theirs") {
      // Integrate only the extra remote lines
      mergedMid.push(item.text);
    }
  }

  return [...prefix, ...mergedMid, ...suffix].join("\n");
}

/**
 * Produce a clear, aligned line diff summary between local ('ours') and remote ('theirs').
 */
export function diffSummary(conflict: ConflictFile): string {
  if (conflict.ours === conflict.theirs) {
    return "(Files are identical — safe to accept either version)";
  }

  const linesA = conflict.ours.split(/\r?\n/);
  const linesB = conflict.theirs.split(/\r?\n/);

  let start = 0;
  while (start < linesA.length && start < linesB.length && linesA[start] === linesB[start]) {
    start++;
  }

  let endA = linesA.length - 1;
  let endB = linesB.length - 1;
  while (endA >= start && endB >= start && linesA[endA] === linesB[endB]) {
    endA--;
    endB--;
  }

  const midA = linesA.slice(start, endA + 1);
  const midB = linesB.slice(start, endB + 1);

  const diffLines: string[] = [];
  if (start > 0) {
    diffLines.push(`@@ Unchanged header (${start} line${start === 1 ? "" : "s"}) @@`);
  }

  const diff = computeLcs(midA, midB);
  for (const d of diff) {
    if (d.type === "ours") {
      diffLines.push(`- ${d.text}`);
    } else if (d.type === "theirs") {
      diffLines.push(`+ ${d.text}`);
    } else {
      diffLines.push(`  ${d.text}`);
    }
  }

  const suffixCount = linesA.length - 1 - endA;
  if (suffixCount > 0) {
    diffLines.push(`@@ Unchanged footer (${suffixCount} line${suffixCount === 1 ? "" : "s"}) @@`);
  }

  return diffLines.length > 0
    ? diffLines.join("\n")
    : "(Files are identical — safe to accept either version)";
}

/** Check if content is non-text/binary */
export function looksBinary(text: string): boolean {
  if (!text) return false;
  if (text.startsWith("[Binary")) return true;
  return text.includes("\u0000");
}

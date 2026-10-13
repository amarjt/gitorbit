import { ConflictFile } from "../types";

/**
 * Produce a clear line-by-line diff summary between local ('ours') and remote ('theirs').
 */
export function diffSummary(conflict: ConflictFile): string {
  const oursLines = conflict.ours.split("\n");
  const theirsLines = conflict.theirs.split("\n");

  const maxLen = Math.max(oursLines.length, theirsLines.length);
  const diffLines: string[] = [];

  for (let i = 0; i < maxLen; i++) {
    const a = oursLines[i] ?? "";
    const b = theirsLines[i] ?? "";
    if (a !== b) {
      diffLines.push(`Line ${i + 1}:`);
      if (a) diffLines.push(`  - ${a}`);
      if (b) diffLines.push(`  + ${b}`);
    }
  }

  return diffLines.length > 0
    ? diffLines.join("\n")
    : "(Files are identical — safe to accept either version)";
}

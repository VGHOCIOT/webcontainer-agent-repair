import type { Attempt, GeneratedFile } from "./types";

// One line of a unified-style diff hunk. "ctx" lines are unchanged context kept
// around a change so the edit is readable; "add"/"del" are the actual delta.
export interface DiffLine {
  type: "add" | "del" | "ctx";
  text: string;
}

export type FileChangeKind = "added" | "removed" | "modified";

export interface FileChange {
  path: string;
  kind: FileChangeKind;
  // Line-level diff for a modified file. Omitted for added/removed files (the
  // whole file is the change; the UI shows it collapsed by default).
  hunks?: DiffLine[];
  // Full contents for added/removed files, so the UI can show them on demand.
  contents?: string;
  added: number;
  removed: number;
}

export interface AttemptDiff {
  index: number;
  // The attempt this one is compared against (the previous attempt that wrote
  // files). null for the first file-writing attempt — nothing to diff against.
  baseIndex: number | null;
  changes: FileChange[];
}

// Classic LCS line diff. Small generated apps mean the inputs are short, so the
// O(n*m) table is fine and keeps the result minimal (only real edits show).
function lineDiff(a: string, b: string): DiffLine[] {
  const aLines = a.split("\n");
  const bLines = b.split("\n");
  const n = aLines.length;
  const m = bLines.length;

  // lcs[i][j] = length of the longest common subsequence of aLines[i:], bLines[j:]
  const lcs: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] =
        aLines[i] === bLines[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (aLines[i] === bLines[j]) {
      lines.push({ type: "ctx", text: aLines[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      lines.push({ type: "del", text: aLines[i] });
      i++;
    } else {
      lines.push({ type: "add", text: bLines[j] });
      j++;
    }
  }
  while (i < n) lines.push({ type: "del", text: aLines[i++] });
  while (j < m) lines.push({ type: "add", text: bLines[j++] });

  return lines;
}

function diffFiles(prev: GeneratedFile[], next: GeneratedFile[]): FileChange[] {
  const prevByPath = new Map(prev.map((f) => [f.path, f.contents]));
  const nextByPath = new Map(next.map((f) => [f.path, f.contents]));
  const changes: FileChange[] = [];

  for (const { path, contents } of next) {
    const before = prevByPath.get(path);
    if (before === undefined) {
      changes.push({
        path,
        kind: "added",
        contents,
        added: contents === "" ? 0 : contents.split("\n").length,
        removed: 0,
      });
    } else if (before !== contents) {
      const hunks = lineDiff(before, contents);
      changes.push({
        path,
        kind: "modified",
        hunks,
        added: hunks.filter((h) => h.type === "add").length,
        removed: hunks.filter((h) => h.type === "del").length,
      });
    }
  }

  for (const { path, contents } of prev) {
    if (!nextByPath.has(path)) {
      changes.push({
        path,
        kind: "removed",
        contents,
        added: 0,
        removed: contents === "" ? 0 : contents.split("\n").length,
      });
    }
  }

  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Per-attempt view of what the model actually *changed* between attempts —
 * pairing each file-writing attempt with the previous one. This is the missing
 * half of the healing timeline: the grid shows which checks flipped, this shows
 * the edit that flipped them, so a fix (or a regression) can be read at the
 * source level, not just as pass/fail.
 */
export function computeAttemptDiffs(attempts: Attempt[]): AttemptDiff[] {
  const withFiles = attempts.filter(
    (a): a is Attempt & { files: GeneratedFile[] } =>
      a.files !== undefined && a.files.length > 0,
  );

  return withFiles.map((attempt, i) => {
    const prev = i === 0 ? null : withFiles[i - 1];
    return {
      index: attempt.index,
      baseIndex: prev ? prev.index : null,
      changes: prev
        ? diffFiles(prev.files, attempt.files)
        : diffFiles([], attempt.files),
    };
  });
}

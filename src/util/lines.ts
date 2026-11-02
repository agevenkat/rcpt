import { createHash } from 'node:crypto';

/**
 * Normalize a line for matching: trim and collapse internal whitespace.
 * Blank lines return null and are never hashed (they carry no authorship signal).
 */
export function normalizeLine(line: string): string | null {
  const n = line.trim().replace(/\s+/g, ' ');
  return n.length ? n : null;
}

export function hashLine(line: string): string | null {
  const n = normalizeLine(line);
  return n === null ? null : createHash('sha256').update(n).digest('hex').slice(0, 16);
}

export function hashLines(lines: string[]): string[] {
  const out: string[] = [];
  for (const l of lines) {
    const h = hashLine(l);
    if (h) out.push(h);
  }
  return out;
}

export interface LineDelta {
  added: string[];
  removed: string[];
}

/** Lines from a unified diff or hunk line array ("+x", "-y", " z"). File headers are ignored. */
export function parseDiffLines(lines: string[]): LineDelta {
  const added: string[] = [];
  const removed: string[] = [];
  for (const l of lines) {
    if (l.startsWith('+++ ') || l.startsWith('--- ')) continue;
    if (l.startsWith('+')) added.push(l.slice(1));
    else if (l.startsWith('-')) removed.push(l.slice(1));
  }
  return { added, removed };
}

export const parseUnifiedDiff = (text: string) => parseDiffLines(text.split('\n'));

/** For edits logged only as old/new strings: multiset difference in both directions. */
export function diffStrings(oldStr: string, newStr: string): LineDelta {
  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');
  const count = new Map<string, number>();
  for (const l of oldLines) count.set(l, (count.get(l) ?? 0) + 1);
  const added: string[] = [];
  for (const l of newLines) {
    const c = count.get(l) ?? 0;
    if (c > 0) count.set(l, c - 1);
    else added.push(l);
  }
  const removed: string[] = [];
  for (const [l, c] of count) for (let i = 0; i < c; i++) removed.push(l);
  return { added, removed };
}

export interface PatchFile extends LineDelta {
  path: string;
  kind: 'create' | 'update' | 'delete';
}

/** Parse the "*** Begin Patch" format used by Codex's apply_patch tool. */
export function parseApplyPatch(text: string): PatchFile[] {
  const files: PatchFile[] = [];
  let cur: PatchFile | null = null;
  for (const line of text.split('\n')) {
    const m = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (m) {
      cur = {
        path: m[2]!.trim(),
        kind: m[1] === 'Add' ? 'create' : m[1] === 'Delete' ? 'delete' : 'update',
        added: [],
        removed: [],
      };
      files.push(cur);
      continue;
    }
    const mv = /^\*\*\* Move to: (.+)$/.exec(line);
    if (mv && cur) {
      cur.path = mv[1]!.trim();
      continue;
    }
    if (!cur || line.startsWith('***') || line.startsWith('@@')) continue;
    if (line.startsWith('+')) cur.added.push(line.slice(1));
    else if (line.startsWith('-')) cur.removed.push(line.slice(1));
  }
  return files;
}

export function countNonBlank(lines: string[]): number {
  return lines.filter((l) => normalizeLine(l) !== null).length;
}

import { execFileSync } from 'node:child_process';

export function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'core.quotepath=off', ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function repoRoot(cwd: string): string {
  return git(cwd, ['rev-parse', '--show-toplevel']).trim();
}

/** All worktrees of the repository (main + linked). */
export function worktreeRoots(root: string): string[] {
  try {
    return git(root, ['worktree', 'list', '--porcelain'])
      .split('\n')
      .filter((l) => l.startsWith('worktree '))
      .map((l) => l.slice('worktree '.length));
  } catch {
    return [root];
  }
}

export interface CommitMeta {
  sha: string;
  parents: string[];
  /** epoch ms */
  committerTime: number;
  authorTime: number;
}

export function commitMeta(root: string, rev: string): CommitMeta {
  const [sha, parents, ct, at] = git(root, ['show', '-s', '--format=%H%x00%P%x00%ct%x00%at', rev, '--']).trim().split('\0');
  return {
    sha: sha!,
    parents: parents ? parents.split(' ').filter(Boolean) : [],
    committerTime: Number(ct) * 1000,
    authorTime: Number(at) * 1000,
  };
}

export interface AddedLine {
  /** 1-based line number in the new version of the file. */
  n: number;
  text: string;
}

/** Added lines per repo-relative path for a non-merge commit (renames detected, so moved files don't count as new). */
export function commitAddedLines(root: string, sha: string): Map<string, AddedLine[]> {
  const out = git(root, ['diff-tree', '-p', '-M', '-U0', '--no-color', '--no-ext-diff', '--no-prefix', '--root', '-r', sha]);
  return parseDiffAdded(out);
}

/**
 * Parse `git diff -U0 --no-prefix` output. Headers are tracked with state because an added line whose
 * content starts with "++" is printed as "+++ …" and is otherwise indistinguishable from a header.
 */
export function parseDiffAdded(diff: string): Map<string, AddedLine[]> {
  const files = new Map<string, AddedLine[]>();
  let current: AddedLine[] | null = null;
  let inHeader = false;
  let n = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      inHeader = true;
      current = null;
      continue;
    }
    if (inHeader) {
      if (line.startsWith('+++ ')) {
        const p = unquote(line.slice(4).replace(/\t$/, ''));
        current = p === '/dev/null' ? null : (files.get(p) ?? []);
        if (current) files.set(p, current);
      } else if (line.startsWith('@@')) {
        inHeader = false;
        n = hunkStart(line);
      }
      continue;
    }
    if (line.startsWith('@@')) n = hunkStart(line);
    else if (current && line.startsWith('+')) current.push({ n: n++, text: line.slice(1) });
    else if (line.startsWith(' ')) n++;
  }
  return files;
}

const hunkStart = (h: string) => Number(/\+(\d+)/.exec(h)?.[1] ?? 1);

/** Undo git's C-style quoting ("a\tb" with octal escapes for bytes). */
function unquote(p: string): string {
  if (!(p.startsWith('"') && p.endsWith('"'))) return p;
  const bytes: number[] = [];
  const s = p.slice(1, -1);
  const esc: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 };
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c !== '\\') {
      bytes.push(...Buffer.from(c, 'utf8'));
      continue;
    }
    const n = s[i + 1]!;
    if (/[0-7]/.test(n)) {
      bytes.push(parseInt(s.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      bytes.push(esc[n] ?? n.charCodeAt(0));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** Non-merge and merge commit shas reachable from HEAD since a date, oldest first. */
export function commitsSince(root: string, since: Date): string[] {
  const out = git(root, ['log', '--format=%H', '--reverse', `--since=${since.toISOString()}`, 'HEAD', '--']);
  return out.split('\n').filter(Boolean);
}

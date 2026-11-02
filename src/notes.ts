import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git } from './git.js';
import type { Receipt } from './types.js';

export const NOTES_REF = 'refs/notes/rcpt';
/** Where `git fetch` puts teammates' notes (glob refspec, so fetch never fails when none exist yet). */
export const remoteNotesRef = (remote: string) => `refs/notes/remotes/${remote}/rcpt`;

/** Local notes first, then fetched remote notes. The first ref holding a note for a commit wins. */
export function notesRefs(root: string): string[] {
  const remotes = git(root, ['for-each-ref', '--format=%(refname)', 'refs/notes/remotes/'])
    .split('\n')
    .filter((r) => r.endsWith('/rcpt'));
  const hasLocal = git(root, ['for-each-ref', '--format=%(refname)', NOTES_REF]).trim() !== '';
  return [...(hasLocal ? [NOTES_REF] : []), ...remotes];
}

export function isReceipt(v: unknown): v is Receipt {
  return typeof v === 'object' && v !== null && typeof (v as Receipt).schemaVersion === 'number' && typeof (v as Receipt).commitSha === 'string';
}

export function readReceipt(root: string, rev: string): Receipt | null {
  for (const ref of notesRefs(root)) {
    try {
      const v: unknown = JSON.parse(git(root, ['notes', `--ref=${ref}`, 'show', rev]));
      if (isReceipt(v)) return v;
    } catch {
      /* no note on this ref, or not JSON */
    }
  }
  return null;
}

/** Every receipt in the repo, keyed by commit sha. Reads all note blobs in one git process. */
export function readAllReceipts(root: string): Map<string, Receipt> {
  const blobByCommit = new Map<string, string>();
  for (const ref of notesRefs(root)) {
    for (const line of git(root, ['notes', `--ref=${ref}`, 'list']).split('\n')) {
      const [blob, commit] = line.split(' ');
      if (blob && commit && !blobByCommit.has(commit)) blobByCommit.set(commit, blob);
    }
  }
  const out = new Map<string, Receipt>();
  if (!blobByCommit.size) return out;
  const commits = [...blobByCommit.keys()];
  const batch = execFileSync('git', ['cat-file', '--batch'], {
    cwd: root,
    input: commits.map((c) => blobByCommit.get(c)).join('\n') + '\n',
    maxBuffer: 1024 * 1024 * 1024,
  });
  let pos = 0;
  for (const commit of commits) {
    const nl = batch.indexOf(10, pos);
    const header = batch.subarray(pos, nl).toString();
    const size = Number(header.split(' ')[2]);
    if (!Number.isFinite(size)) break;
    const body = batch.subarray(nl + 1, nl + 1 + size).toString('utf8');
    pos = nl + 1 + size + 1;
    try {
      const v: unknown = JSON.parse(body);
      if (isReceipt(v)) out.set(commit, v);
    } catch {
      /* foreign or corrupt note: ignore */
    }
  }
  return out;
}

/** Write (or replace) the receipt note on a commit. Retries briefly if another rcpt process holds the notes lock. */
export async function writeReceipt(root: string, sha: string, receipt: Receipt): Promise<void> {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rcpt-note-')), 'note.json');
  fs.writeFileSync(tmp, JSON.stringify(receipt, null, 2) + '\n');
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        git(root, ['notes', `--ref=${NOTES_REF}`, 'add', '-f', '-F', tmp, sha]);
        return;
      } catch (err) {
        if (attempt >= 5 || !/lock|already exists|cannot update/i.test(String((err as { stderr?: unknown }).stderr ?? err))) throw err;
        await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
      }
    }
  } finally {
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  }
}

export function hasLocalNote(root: string, sha: string): boolean {
  try {
    git(root, ['notes', `--ref=${NOTES_REF}`, 'list', sha]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Share notes with a remote: fetch theirs, merge (ours wins on the rare commit both sides annotated),
 * then push. --no-verify keeps our own pre-push hook from re-triggering.
 */
export function syncNotes(root: string, remote: string): void {
  const theirs = remoteNotesRef(remote);
  git(root, ['fetch', '--no-write-fetch-head', remote, `+refs/notes/rcpt*:refs/notes/remotes/${remote}/rcpt*`]);
  const hasTheirs = git(root, ['for-each-ref', '--format=%(refname)', theirs]).trim() !== '';
  const hasOurs = git(root, ['for-each-ref', '--format=%(refname)', NOTES_REF]).trim() !== '';
  if (hasTheirs) git(root, ['notes', `--ref=${NOTES_REF}`, 'merge', '-q', '-s', 'ours', theirs]);
  if (hasOurs || hasTheirs) git(root, ['push', '--no-verify', '-q', remote, `${NOTES_REF}:${NOTES_REF}`]);
}

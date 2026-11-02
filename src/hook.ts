import fs from 'node:fs';
import path from 'node:path';
import { createAdapters } from './adapters/index.js';
import type { ParseResult } from './adapters/types.js';
import { attributeCommit, attributeStaged } from './attribute.js';
import { loadConfig } from './config.js';
import { loadPricing } from './cost.js';
import { commitsSince, git, repoRoot } from './git.js';
import { logError } from './log.js';
import { hasLocalNote, syncNotes, writeReceipt } from './notes.js';
import type { Receipt } from './types.js';

function context(cwd: string) {
  const root = repoRoot(cwd);
  const config = loadConfig(root);
  return { root, config, adapters: createAdapters(), pricing: loadPricing(config.pricing) };
}

/** Rebases replay commits; their notes are carried over by notes.rewriteRef instead. */
function replaying(root: string): boolean {
  const gitDir = path.resolve(root, git(root, ['rev-parse', '--git-dir']).trim());
  return ['rebase-merge', 'rebase-apply'].some((d) => fs.existsSync(path.join(gitDir, d)));
}

/** post-commit (already backgrounded by the hook script): attribute HEAD and attach the receipt. */
export async function postCommit(cwd: string, rev?: string): Promise<void> {
  try {
    const { root, ...c } = context(cwd);
    if (replaying(root)) return;
    const sha = git(root, ['rev-parse', '--verify', `${rev || 'HEAD'}^{commit}`]).trim();
    const receipt = await attributeCommit({ repoDir: root, rev: sha, ...c });
    await writeReceipt(root, sha, receipt);
  } catch (err) {
    logError('post-commit hook failed', err);
  }
}

/** pre-push (backgrounded): share receipts with the remote being pushed to. */
export async function prePush(cwd: string, remote: string | undefined): Promise<void> {
  try {
    const root = repoRoot(cwd);
    if (remote) syncNotes(root, remote);
  } catch (err) {
    logError(`pre-push notes sync to ${remote ?? '?'} failed`, err);
  }
}

/** Trailer text for an AI-assisted change, e.g. "claude-code/claude-opus-5-5; ai-lines=42/50". */
export function trailerValue(r: Receipt): string | null {
  if (!r.aiAssisted) return null;
  const who = [...new Set(r.sessions.filter((s) => s.confidence !== 'low').flatMap((s) => (s.models.length ? s.models.map((m) => `${s.agent}/${m}`) : [s.agent])))];
  const ai = r.totals.unknownLines > 0 ? '?' : String(r.totals.aiLinesAdded);
  return `${who.join(', ')}; ai-lines=${ai}/${r.totals.totalLinesAdded}`;
}

/** commit-msg (synchronous, opt-in): add an AI-Assisted trailer. Never blocks the commit on failure. */
export async function commitMsg(cwd: string, msgFile: string | undefined): Promise<void> {
  try {
    const { root, ...c } = context(cwd);
    if (!c.config.trailer || !msgFile || replaying(root)) return;
    const value = trailerValue(await attributeStaged({ repoDir: root, ...c }));
    if (value) git(root, ['interpret-trailers', '--in-place', '--if-exists', 'replace', '--trailer', `AI-Assisted: ${value}`, path.resolve(root, msgFile)]);
  } catch (err) {
    logError('commit-msg hook failed', err);
  }
}

export interface BackfillResult {
  considered: number;
  written: number;
  skippedExisting: number;
  aiAssisted: number;
  failed: number;
}

/** Generate receipts for past commits. Sessions are parsed once and shared across commits. */
export async function backfill(
  cwd: string,
  since: Date,
  o: { force?: boolean; dryRun?: boolean; onProgress?: (done: number, total: number) => void } = {},
): Promise<BackfillResult> {
  const { root, ...c } = context(cwd);
  const shas = commitsSince(root, since);
  const cache = new Map<string, ParseResult>();
  const res: BackfillResult = { considered: shas.length, written: 0, skippedExisting: 0, aiAssisted: 0, failed: 0 };
  for (const [i, sha] of shas.entries()) {
    o.onProgress?.(i, shas.length);
    if (!o.force && hasLocalNote(root, sha)) {
      res.skippedExisting++;
      continue;
    }
    try {
      const receipt = await attributeCommit({ repoDir: root, rev: sha, cache, ...c });
      if (receipt.aiAssisted) res.aiAssisted++;
      if (!o.dryRun) await writeReceipt(root, sha, receipt);
      res.written++;
    } catch (err) {
      res.failed++;
      logError(`backfill failed for ${sha}`, err);
    }
  }
  o.onProgress?.(shas.length, shas.length);
  return res;
}

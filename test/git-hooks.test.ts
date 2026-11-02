import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { at, claudeSession, commitAt, gitIn, initRepo, noHooks, tmpDir, write } from './helpers.js';
import { init, uninstall } from '../src/install.js';
import { readReceipt, NOTES_REF } from '../src/notes.js';
import { trailerValue } from '../src/hook.js';

const CLI = path.resolve(import.meta.dirname, '..', 'dist', 'cli.js');
const home = tmpDir('hookhome');
const rcptHome = tmpDir('hookrcpt');
// Hooks run in a child process of git: point them at the fake agent logs via HOME.
const env = { HOME: home, USERPROFILE: home, RCPT_HOME: rcptHome };

function rcpt(cwd: string, args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
}

async function waitFor<T>(fn: () => T | null, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Everything uninstall must restore: git config, hooks and working tree files (not objects/refs/logs). */
function snapshot(repo: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, rel: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      const r = path.join(rel, e.name);
      if (['objects', 'logs', 'refs', 'index', 'COMMIT_EDITMSG', 'ORIG_HEAD', 'FETCH_HEAD'].includes(e.name) && rel === '.git') continue;
      if (e.isDirectory()) walk(p, r);
      else out[r] = `${fs.statSync(p).mode.toString(8)}:${fs.readFileSync(p, 'utf8')}`;
    }
  };
  walk(repo, '');
  return out;
}

function newRepo(name: string, withCommit = true): string {
  const repo = tmpDir(name);
  initRepo(repo);
  if (withCommit) {
    write(path.join(repo, 'README.md'), '# r\n');
    commitAt(repo, new Date(Date.now() - 3600_000), 'init');
  }
  return repo;
}

/** A real-time commit with git hooks enabled (commitAt disables them). */
function hookedCommit(repo: string, message: string) {
  gitIn(repo, ['add', '-A']);
  const t0 = performance.now();
  const r = spawnSync('git', ['commit', '-q', '-m', message], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: path.join(os.tmpdir(), 'rcpt-empty-gitconfig'),
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@example.invalid',
    },
  });
  return { ...r, ms: performance.now() - t0, sha: gitIn(repo, ['rev-parse', 'HEAD']).trim() };
}

afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

describe('rcpt init + post-commit hook', () => {
  let repo: string;
  beforeAll(() => {
    repo = newRepo('hooked');
    const r = rcpt(repo, ['init', '--no-sync']);
    expect(r.status).toBe(0);
    commitAt(repo, new Date(Date.now() - 1800_000), 'add rcpt config');
  });

  it('creates config and a post-commit hook', () => {
    expect(fs.existsSync(path.join(repo, '.rcpt.json'))).toBe(true);
    const hook = fs.readFileSync(path.join(repo, '.git', 'hooks', 'post-commit'), 'utf8');
    expect(hook).toContain('# >>> rcpt >>>');
    if (process.platform !== 'win32') expect(fs.statSync(path.join(repo, '.git', 'hooks', 'post-commit')).mode & 0o111).not.toBe(0);
  });

  it('attaches a receipt note within seconds of an AI-assisted commit, without slowing the commit', async () => {
    const now = new Date();
    const file = path.join(repo, 'ai.js');
    claudeSession(home, {
      id: 'hook-session',
      cwd: repo,
      events: [
        { t: at(now, -2), kind: 'prompt', text: 'write ai.js' },
        { t: at(now, -1), kind: 'write', path: file, content: 'export const ai = true;\nexport const n = 42;\n' },
      ],
    });
    write(file, 'export const ai = true;\nexport const n = 42;\n');
    const c = hookedCommit(repo, 'ai commit');
    expect(c.status).toBe(0);
    expect(c.stdout + c.stderr).toBe('');

    const receipt = await waitFor(() => readReceipt(repo, c.sha));
    expect(receipt).toMatchObject({ commitSha: c.sha, aiAssisted: true, totals: { aiLinesAdded: 2, totalLinesAdded: 2 } });

  });

  it('adds well under 300ms to a commit (median of 3, hook vs no hook)', () => {
    const median = (xs: number[]) => xs.sort((a, b) => a - b)[1]!;
    const hooked: number[] = [];
    const plain: number[] = [];
    for (let i = 0; i < 3; i++) {
      write(path.join(repo, `h${i}.txt`), `${i}\n`);
      hooked.push(hookedCommit(repo, `h${i}`).ms);
      write(path.join(repo, `p${i}.txt`), `${i}\n`);
      gitIn(repo, ['add', '-A']);
      const t0 = performance.now();
      gitIn(repo, [...noHooks(), 'commit', '-q', '-m', `p${i}`], env);
      plain.push(performance.now() - t0);
    }
    console.log(`commit with hook: ${median(hooked).toFixed(0)}ms median, without: ${median(plain).toFixed(0)}ms median`);
    expect(median(hooked) - median(plain)).toBeLessThan(300);
  });

  it('shows the receipt in the terminal', () => {
    const sha = gitIn(repo, ['log', '--format=%H', '--grep=^ai commit$']).trim();
    const r = rcpt(repo, ['receipt', sha]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('🧾 rcpt receipt');
    expect(r.stdout).toContain('ai.js');
    expect(r.stdout).toMatch(/2 \/ 2/);
  });

  it('reports a missing receipt without calling the commit human', () => {
    // HEAD was committed with hooks disabled, so it has no receipt.
    const r = rcpt(repo, ['receipt', 'HEAD']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("doesn't mean the commit is human-written");
  });
});

describe('the hook can never break a commit', () => {
  it('a crashing rcpt is silent and the commit succeeds', () => {
    const repo = newRepo('broken');
    const bad = path.join(tmpDir('bad'), 'cli.js');
    write(bad, 'console.error("BOOM"); process.exit(3);\n');
    init(repo, { cli: { node: process.execPath, script: bad }, sync: false, trailer: false });
    write(path.join(repo, 'f.txt'), 'f\n');
    const c = hookedCommit(repo, 'still works');
    expect(c.status).toBe(0);
    expect(c.stderr).toBe('');
  });

  it('RCPT_DISABLE=1 skips the hook entirely', () => {
    const repo = newRepo('disabled');
    init(repo, { cli: { node: process.execPath, script: CLI }, sync: false, trailer: false });
    const hook = fs.readFileSync(path.join(repo, '.git', 'hooks', 'post-commit'), 'utf8');
    expect(hook).toContain('RCPT_DISABLE');
  });
});

describe('chaining with existing hooks', () => {
  it('inserts into an existing shell hook, keeps it running, and uninstall restores it byte-for-byte', () => {
    const repo = newRepo('chain-sh');
    const hookPath = path.join(repo, '.git', 'hooks', 'post-commit');
    const original = '#!/bin/sh\necho ran >> "$(git rev-parse --git-dir)/marker"\nexit 0\n';
    fs.writeFileSync(hookPath, original, { mode: 0o755 });
    init(repo, { cli: { node: process.execPath, script: CLI }, sync: false, trailer: false });
    const text = fs.readFileSync(hookPath, 'utf8');
    expect(text.indexOf('# >>> rcpt >>>')).toBeLessThan(text.indexOf('exit 0'));
    write(path.join(repo, 'f.txt'), 'f\n');
    expect(hookedCommit(repo, 'c').status).toBe(0);
    expect(fs.readFileSync(path.join(repo, '.git', 'marker'), 'utf8')).toBe('ran\n');
    uninstall(repo);
    expect(fs.readFileSync(hookPath, 'utf8')).toBe(original);
  });

  it('wraps a non-shell hook and restores it on uninstall', () => {
    const repo = newRepo('chain-node');
    const hookPath = path.join(repo, '.git', 'hooks', 'post-commit');
    const original = `#!${process.execPath}\nrequire('fs').appendFileSync(require('path').join(process.cwd(), '.git', 'node-marker'), 'ran\\n');\n`;
    fs.writeFileSync(hookPath, original, { mode: 0o755 });
    init(repo, { cli: { node: process.execPath, script: CLI }, sync: false, trailer: false });
    expect(fs.existsSync(`${hookPath}.rcpt-chained`)).toBe(true);
    write(path.join(repo, 'f.txt'), 'f\n');
    expect(hookedCommit(repo, 'c').status).toBe(0);
    expect(fs.readFileSync(path.join(repo, '.git', 'node-marker'), 'utf8')).toBe('ran\n');
    uninstall(repo);
    expect(fs.readFileSync(hookPath, 'utf8')).toBe(original);
    expect(fs.existsSync(`${hookPath}.rcpt-chained`)).toBe(false);
  });

  it('uses .husky/<hook> when Husky manages hooks', () => {
    const repo = newRepo('husky');
    fs.mkdirSync(path.join(repo, '.husky', '_'), { recursive: true });
    gitIn(repo, ['config', 'core.hooksPath', '.husky/_']);
    const before = snapshot(repo);
    init(repo, { cli: { node: process.execPath, script: CLI }, sync: false, trailer: false });
    expect(fs.readFileSync(path.join(repo, '.husky', 'post-commit'), 'utf8')).toContain('# >>> rcpt >>>');
    expect(fs.existsSync(path.join(repo, '.git', 'hooks', 'post-commit'))).toBe(false);
    uninstall(repo);
    expect(snapshot(repo)).toEqual(before);
  });

  it('adds a command to lefthook-local.yml when lefthook is used', () => {
    const repo = newRepo('lefthook');
    write(path.join(repo, 'lefthook.yml'), 'pre-commit:\n  commands:\n    lint:\n      run: echo lint\n');
    const before = snapshot(repo);
    init(repo, { cli: { node: process.execPath, script: CLI }, sync: true, trailer: false });
    const local = fs.readFileSync(path.join(repo, 'lefthook-local.yml'), 'utf8');
    expect(local).toMatch(/^post-commit:\n {2}commands:\n {4}rcpt:\n {6}run: \|/m);
    expect(local).toMatch(/^pre-push:/m);
    expect(local).toContain('hook pre-push {1}');
    expect(local.match(/# >>> rcpt >>>/g)).toHaveLength(2);
    uninstall(repo);
    expect(snapshot(repo)).toEqual(before);
  });
});

describe('receipt sharing through a remote', () => {
  let remote: string;
  let a: string;
  beforeAll(() => {
    remote = path.join(tmpDir('remote'), 'r.git');
    gitIn(path.dirname(remote), ['init', '-q', '--bare', remote]);
    a = newRepo('share-a');
    gitIn(a, ['remote', 'add', 'origin', remote]);
    gitIn(a, ['push', '-q', 'origin', 'main']);
  });

  it('init --yes leaves the repo exactly as it was after uninstall', () => {
    const repo = newRepo('exact');
    gitIn(repo, ['remote', 'add', 'origin', remote]);
    const before = snapshot(repo);
    expect(rcpt(repo, ['init', '--yes']).status).toBe(0);
    const cfg = gitIn(repo, ['config', '--local', '--list']);
    expect(cfg).toContain('remote.origin.fetch=+refs/notes/rcpt*:refs/notes/remotes/origin/rcpt*');
    expect(cfg).toContain('notes.rewriteref=refs/notes/rcpt');
    expect(cfg).not.toContain('remote.origin.push');
    expect(rcpt(repo, ['uninstall']).status).toBe(0);
    expect(snapshot(repo)).toEqual(before);
  });

  it('pushes notes in the background on push, fetch works before any notes exist, and teammates can read them', async () => {
    expect(rcpt(a, ['init', '--yes']).status).toBe(0);
    // A fetch with the notes refspec must not fail while the remote has no notes yet.
    expect(() => gitIn(a, ['fetch', '-q', 'origin'])).not.toThrow();

    write(path.join(a, 'b.txt'), 'b\n');
    const c = hookedCommit(a, 'b');
    await waitFor(() => readReceipt(a, c.sha));
    const push = spawnSync('git', ['push', '-q', 'origin', 'main'], { cwd: a, encoding: 'utf8', env: { ...process.env, ...env, GIT_CONFIG_GLOBAL: path.join(os.tmpdir(), 'rcpt-empty-gitconfig') } });
    expect(push.status).toBe(0);
    // The branch itself was pushed (rcpt never changes what `git push` pushes)...
    expect(gitIn(remote, ['rev-parse', 'main']).trim()).toBe(c.sha);
    // ...and the notes follow shortly after, from the background pre-push sync.
    await waitFor(() => {
      try {
        return gitIn(remote, ['rev-parse', '-q', '--verify', NOTES_REF]).trim();
      } catch {
        return null;
      }
    });

    const b = path.join(tmpDir('share-b'), 'b');
    gitIn(path.dirname(b), ['clone', '-q', remote, b]);
    expect(rcpt(b, ['init', '--yes']).status).toBe(0);
    gitIn(b, ['fetch', '-q', 'origin']);
    expect(readReceipt(b, c.sha)?.commitSha).toBe(c.sha);
  });

  it('amending keeps a single valid receipt on the new commit', async () => {
    write(path.join(a, 'c.txt'), 'c\n');
    const first = hookedCommit(a, 'c');
    await waitFor(() => readReceipt(a, first.sha));
    write(path.join(a, 'c.txt'), 'c2\n');
    gitIn(a, ['add', '-A']);
    spawnSync('git', ['commit', '-q', '--amend', '-m', 'c amended'], { cwd: a, env: { ...process.env, ...env, GIT_CONFIG_GLOBAL: path.join(os.tmpdir(), 'rcpt-empty-gitconfig') } });
    const amended = gitIn(a, ['rev-parse', 'HEAD']).trim();
    expect(amended).not.toBe(first.sha);
    const r = await waitFor(() => {
      const x = readReceipt(a, amended);
      return x?.commitSha === amended ? x : null;
    });
    expect(r.commitSha).toBe(amended);
    expect(() => JSON.parse(gitIn(a, ['notes', `--ref=${NOTES_REF}`, 'show', amended]))).not.toThrow();
  });
});

describe('commit trailer (opt-in)', () => {
  it('adds AI-Assisted to AI-assisted commits when enabled', () => {
    const repo = newRepo('trailer');
    write(path.join(repo, '.rcpt.json'), JSON.stringify({ trailer: true }));
    expect(rcpt(repo, ['init', '--no-sync']).status).toBe(0);
    commitAt(repo, new Date(Date.now() - 1800_000), 'config');
    const now = new Date();
    const file = path.join(repo, 't.js');
    claudeSession(home, {
      id: 'trailer-session',
      cwd: repo,
      events: [{ t: at(now, -1), kind: 'write', path: file, content: 'const t = 1;\nconst u = 2;\n' }],
    });
    write(file, 'const t = 1;\nconst u = 2;\nconst human = 3;\n');
    const c = hookedCommit(repo, 'with trailer');
    expect(c.status).toBe(0);
    const msg = gitIn(repo, ['log', '-1', '--format=%B']);
    expect(msg).toContain('AI-Assisted: claude-code/claude-opus-5-5; ai-lines=2/3');
  });

  it('formats trailers, marking unknown line shares', () => {
    const r = { aiAssisted: true, sessions: [{ agent: 'codex', models: ['gpt-6-luna'], confidence: 'medium' }], totals: { aiLinesAdded: 0, totalLinesAdded: 9, unknownLines: 9 } };
    expect(trailerValue(r as never)).toBe('codex/gpt-6-luna; ai-lines=?/9');
    expect(trailerValue({ ...r, aiAssisted: false } as never)).toBeNull();
  });
});

describe('backfill', () => {
  it('writes receipts for past commits and skips ones that already have them', () => {
    const repo = newRepo('backfill', false);
    const T = new Date(Date.now() - 2 * 86_400_000);
    write(path.join(repo, 'a.txt'), 'a\n');
    commitAt(repo, T, 'a');
    claudeSession(home, {
      id: 'backfill-session',
      cwd: repo,
      events: [{ t: at(T, 10), kind: 'write', path: path.join(repo, 'b.js'), content: 'const b = 1;\n' }],
    });
    write(path.join(repo, 'b.js'), 'const b = 1;\n');
    const b = commitAt(repo, at(T, 15), 'b');

    const first = rcpt(repo, ['backfill', '--since', '7d']);
    expect(first.status).toBe(0);
    expect(first.stdout).toContain('2 commits in the last 7d: 2 receipts written, 1 AI-assisted, 0 already had receipts');
    expect(readReceipt(repo, b)?.totals).toMatchObject({ aiLinesAdded: 1, totalLinesAdded: 1 });
    const second = rcpt(repo, ['backfill', '--since', '7d']);
    expect(second.stdout).toContain('0 receipts written, 0 AI-assisted, 2 already had receipts');
  });
});

describe('cli errors', () => {
  it('explains when run outside a git repository', () => {
    const r = rcpt(tmpDir('nogit'), ['receipt']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('not inside a git repository');
  });
});

// Keep the linter quiet about unused imports in some environments.
void execFileSync;

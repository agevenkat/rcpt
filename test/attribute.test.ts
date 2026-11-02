import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { attributeCommit, effectiveCwd, fromRanges, isGitCommit, mayWriteFiles, summarize, toRanges } from '../src/attribute.js';
import { createAdapters } from '../src/adapters/index.js';
import { DEFAULT_CONFIG, globToRegExp } from '../src/config.js';
import { costOf, loadPricing, priceFor } from '../src/cost.js';
import { parseDiffAdded } from '../src/git.js';
import { canonical, isUnder, normPath, relTo } from '../src/paths.js';
import { isTestCommand } from '../src/util/test-commands.js';
import type { Receipt } from '../src/types.js';
import { at, claudeSession, codexSession, commitAt, geminiSession, gitIn, initRepo, tmpDir, write } from './helpers.js';

const T0 = new Date('2026-10-01T09:00:00Z');

describe('attribution (integration)', () => {
  const home = tmpDir('home');
  const repo = tmpDir('repo');
  const wt = path.join(tmpDir('wt'), 'feature');
  const sha: Record<string, string> = {};
  const receipts: Record<string, Receipt> = {};
  const attribute = (repoDir: string, rev: string, config = DEFAULT_CONFIG) =>
    attributeCommit({ repoDir, rev, adapters: createAdapters({ home, env: {} }), config, pricing: loadPricing(), now: T0 });

  beforeAll(async () => {
    process.env.RCPT_HOME = tmpDir('rcpthome');
    initRepo(repo);

    // c0: human root commit, no sessions anywhere near it.
    write(path.join(repo, 'README.md'), '# Demo\n');
    sha.c0 = commitAt(repo, T0, 'init');

    // c1: Claude (cwd = a subdirectory) writes src/sum.js and runs passing tests.
    claudeSession(home, {
      id: 'claude-1',
      cwd: path.join(repo, 'src'),
      events: [
        { t: at(T0, 10), kind: 'prompt', text: 'Add a sum function. token=ghp_FAKEFAKEFAKEFAKEFAKEFAKE1234' },
        { t: at(T0, 11), kind: 'write', path: path.join(repo, 'src', 'sum.js'), content: 'export function sum(a, b) {\n  return a + b;\n}\n' },
        { t: at(T0, 12), kind: 'bash', command: 'npm test', exitCode: 0 },
      ],
    });
    write(path.join(repo, 'src', 'sum.js'), 'export function sum(a, b) {\n  return a + b;\n}\n');
    sha.c1 = commitAt(repo, at(T0, 15), 'sum');

    // c2: Codex adds 2 lines; a human adds 2 more lines and a new file. Codex's tests fail.
    codexSession(home, {
      id: '22222222-0000-4000-8000-000000000002',
      cwd: repo,
      model: 'gpt-6-luna',
      start: at(T0, 30),
      events: [
        { t: at(T0, 30), kind: 'prompt', text: 'Add twice() and zero' },
        { t: at(T0, 31), kind: 'update', path: path.join(repo, 'src', 'sum.js'), diff: '@@ -3 +3,3 @@\n }\n+export const twice = (x) => sum(x, x);\n+export const zero = 0;\n' },
        { t: at(T0, 32), kind: 'command', command: 'npm test', exitCode: 1 },
      ],
    });
    write(
      path.join(repo, 'src', 'sum.js'),
      'export function sum(a, b) {\n  return a + b;\n}\nexport const twice = (x) => sum(x, x);\nexport const zero = 0;\n// human comment\nexport const one = 1;\n',
    );
    write(path.join(repo, 'notes.txt'), 'written by a person\n');
    sha.c2 = commitAt(repo, at(T0, 40), 'mixed');

    // c3: fully human, hours later.
    write(path.join(repo, 'README.md'), '# Demo\n\nHuman docs.\n');
    sha.c3 = commitAt(repo, at(T0, 180), 'docs');

    // c4: Gemini (matched by project hash) edits README and writes mul.js, which a human then rewrites.
    const toolCalls = [
      { id: 'g1', name: 'replace', status: 'success', timestamp: at(T0, 241).toISOString(), args: { file_path: path.join(repo, 'README.md'), old_string: 'Human docs.', new_string: 'Human docs.\nMultiply too.' } },
      { id: 'g2', name: 'write_file', status: 'success', timestamp: at(T0, 242).toISOString(), args: { file_path: path.join(repo, 'mul.js'), content: 'export const mul = (a, b) => a * b;\n' } },
    ];
    geminiSession(home, {
      id: 'gem-1',
      projectRoot: normPath(repo),
      model: 'gemini-3.8-flash',
      start: at(T0, 240),
      messages: [
        { id: 'm1', timestamp: at(T0, 240).toISOString(), type: 'user', content: 'Mention multiply and add mul()' },
        { id: 'm2', timestamp: at(T0, 242).toISOString(), type: 'gemini', model: 'gemini-3.8-flash', content: 'ok', tokens: { input: 2000, output: 100, cached: 0, thoughts: 0, tool: 0 }, toolCalls },
      ],
    });
    // A second Gemini session in this project with no edits: time window + repo only -> low.
    geminiSession(home, {
      id: 'gem-2',
      projectRoot: normPath(repo),
      model: 'gemini-3.8-flash',
      start: at(T0, 243),
      messages: [{ id: 'm1', timestamp: at(T0, 243).toISOString(), type: 'user', content: 'what does this repo do?' }],
    });
    write(path.join(repo, 'README.md'), '# Demo\n\nHuman docs.\nMultiply too.\n');
    write(path.join(repo, 'mul.js'), 'export function mul(a, b) { return a * b }\n');
    sha.c4 = commitAt(repo, at(T0, 250), 'mul');

    // c5: a linked worktree; Claude works there without token usage.
    gitIn(repo, ['worktree', 'add', '-q', '-b', 'feature', wt]);
    claudeSession(home, {
      id: 'claude-wt',
      cwd: wt,
      usage: false,
      events: [
        { t: at(T0, 300), kind: 'prompt', text: 'Add a feature flag' },
        { t: at(T0, 301), kind: 'write', path: path.join(wt, 'feature.js'), content: 'export const enabled = true;\n' },
      ],
    });
    write(path.join(wt, 'feature.js'), 'export const enabled = true;\n');
    sha.c5 = commitAt(wt, at(T0, 310), 'feature');

    // c6: merge the worktree branch back.
    gitIn(repo, ['merge', '-q', '--no-ff', '-m', 'merge', 'feature'], { GIT_AUTHOR_DATE: at(T0, 320).toISOString(), GIT_COMMITTER_DATE: at(T0, 320).toISOString() });
    sha.c6 = gitIn(repo, ['rev-parse', 'HEAD']).trim();

    // c7: the agent writes a file through a script (no edit diff in its log) and runs `git commit` itself.
    claudeSession(home, {
      id: 'claude-shell',
      cwd: repo,
      events: [
        { t: at(T0, 330), kind: 'prompt', text: 'Generate the changelog and commit it' },
        { t: at(T0, 331), kind: 'bash', command: "python3 - <<'EOF'\nopen('CHANGELOG.md','w').write('...')\nEOF", exitCode: 0 },
        { t: at(T0, 340), kind: 'bash', command: 'git add -A && git commit -m "changelog"', exitCode: 0 },
      ],
    });
    // Same window, same session cwd, but it commits in another repo: must not count as ran-commit.
    claudeSession(home, {
      id: 'claude-elsewhere',
      cwd: repo,
      events: [{ t: at(T0, 340), kind: 'bash', command: `cd ${tmpDir('other')} && git commit -m other`, exitCode: 0 }],
    });
    write(path.join(repo, 'CHANGELOG.md'), '# Changelog\n- sum\n- mul\n');
    sha.c7 = commitAt(repo, at(T0, 340), 'changelog');

    for (const k of ['c0', 'c1', 'c2', 'c3', 'c4', 'c6', 'c7']) receipts[k] = await attribute(repo, sha[k]!);
    receipts.c5 = await attribute(wt, sha.c5!);
  });

  it('root commit with no sessions is human-written with high confidence', () => {
    const r = receipts.c0!;
    expect(r).toMatchObject({ aiAssisted: false, confidence: null, sessions: [], totals: { aiLinesAdded: 0, totalLinesAdded: 1, unknownLines: 0, ignoredLines: 0 } });
    expect(r.filesAttributed).toEqual([{ path: 'README.md', aiLinesAdded: 0, totalLinesAdded: 1, confidence: 'high' }]);
    expect(r.estimatedCostUsd.amount).toBeNull();
  });

  it('fully AI-written commit from a session in a subdirectory: high confidence, tests passed, cost', () => {
    const r = receipts.c1!;
    expect(r.aiAssisted).toBe(true);
    expect(r.confidence).toBe('high');
    expect(r.sessions).toEqual([expect.objectContaining({ id: 'claude-1', agent: 'claude-code', confidence: 'high', evidence: ['line-match', 'file-match'] })]);
    expect(r.filesAttributed).toEqual([{ path: 'src/sum.js', aiLinesAdded: 3, totalLinesAdded: 3, confidence: 'high', aiLines: '1-3' }]);
    expect(r.testsRun).toEqual({ status: 'passed', command: 'npm test' });
    expect(r.humanEditedAfterAi).toBe(false);
    // 2 API messages x (1000 in @ $4 + 500 out @ $20) per 1M tokens
    expect(r.estimatedCostUsd).toMatchObject({ amount: 0.028, confidence: 'high', unpricedModels: [] });
    expect(r.promptSummary).toBe('Add a sum function. token=[REDACTED:github-token]');
    expect(r.prompts).toBeUndefined();
  });

  it('mixed AI + human commit: per-file line counts and human-edit detection', () => {
    const r = receipts.c2!;
    expect(r.sessions).toEqual([expect.objectContaining({ agent: 'codex', models: ['gpt-6-luna'], confidence: 'high', aiLinesAdded: 2 })]);
    expect(r.sessions[0]!.estimatedCostUsd).toBe(r.estimatedCostUsd.amount);
    expect(r.filesAttributed).toEqual([
      { path: 'notes.txt', aiLinesAdded: 0, totalLinesAdded: 1, confidence: 'medium' },
      { path: 'src/sum.js', aiLinesAdded: 2, totalLinesAdded: 4, confidence: 'high', aiLines: '4-5' },
    ]);
    expect(r.totals).toEqual({ aiLinesAdded: 2, totalLinesAdded: 5, unknownLines: 0, ignoredLines: 0 });
    expect(r.humanEditedAfterAi).toBe(true);
    expect(r.testsRun.status).toBe('failed');
    expect(r.estimatedCostUsd.amount).toBeGreaterThan(0);
    // The Claude session from c1 is outside this commit's window.
    expect(r.sessions.map((s) => s.id)).not.toContain('claude-1');
  });

  it('fully human commit after earlier AI work: no sessions linked', () => {
    const r = receipts.c3!;
    expect(r).toMatchObject({ aiAssisted: false, confidence: null, sessions: [], humanEditedAfterAi: null });
    expect(r.filesAttributed).toEqual([{ path: 'README.md', aiLinesAdded: 0, totalLinesAdded: 1, confidence: 'high' }]);
    expect(r.testsRun.status).toBe('none');
  });

  it('Gemini via project hash: line match, rewritten file is medium, idle session is low', () => {
    const r = receipts.c4!;
    expect(r.sessions).toEqual([
      expect.objectContaining({ id: 'gem-1', agent: 'gemini-cli', confidence: 'high' }),
      expect.objectContaining({ id: 'gem-2', confidence: 'low', evidence: ['time-window'] }),
    ]);
    expect(r.filesAttributed).toEqual([
      { path: 'README.md', aiLinesAdded: 1, totalLinesAdded: 1, confidence: 'high', aiLines: '4' },
      { path: 'mul.js', aiLinesAdded: 0, totalLinesAdded: 1, confidence: 'medium' },
    ]);
    expect(r.humanEditedAfterAi).toBe(true);
    expect(r.promptSummary).toBe('Mention multiply and add mul()');
  });

  it('linked worktree commit; missing token usage gives a null cost, never 0', () => {
    const r = receipts.c5!;
    expect(r.sessions).toEqual([expect.objectContaining({ id: 'claude-wt', confidence: 'high' })]);
    expect(r.filesAttributed).toEqual([{ path: 'feature.js', aiLinesAdded: 1, totalLinesAdded: 1, confidence: 'high', aiLines: '1' }]);
    expect(r.estimatedCostUsd.amount).toBeNull();
  });

  it('agent that wrote via shell and ran the commit: AI-assisted, but line share unknown (null, not 0)', () => {
    const r = receipts.c7!;
    expect(r.aiAssisted).toBe(true);
    expect(r.sessions).toEqual([
      expect.objectContaining({ id: 'claude-shell', confidence: 'medium', evidence: ['ran-commit'] }),
      expect.objectContaining({ id: 'claude-elsewhere', confidence: 'low', evidence: ['time-window'] }),
    ]);
    expect(r.filesAttributed).toEqual([{ path: 'CHANGELOG.md', aiLinesAdded: null, totalLinesAdded: 3, confidence: 'low' }]);
    expect(r.totals).toEqual({ aiLinesAdded: 0, totalLinesAdded: 3, unknownLines: 3, ignoredLines: 0 });
    expect(r.humanEditedAfterAi).toBeNull();
  });

  it('merge commits are marked and not attributed', () => {
    expect(receipts.c6).toMatchObject({ isMerge: true, aiAssisted: false, filesAttributed: [] });
  });

  it('stores full prompts only when opted in', async () => {
    const r = await attribute(repo, sha.c1!, { ...DEFAULT_CONFIG, storeFullPrompts: true });
    expect(r.prompts).toEqual(['Add a sum function. token=[REDACTED:github-token]']);
  });

  it('honors extra test patterns from config', async () => {
    const r = await attribute(repo, sha.c2!, { ...DEFAULT_CONFIG, testPatterns: ['^never-matches$'] });
    expect(r.testsRun.status).toBe('failed');
  });

  it('cleans up', () => {
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe('diff parsing', () => {
  it('does not mistake an added "++" line for a file header', () => {
    const diff = [
      'diff --git plain.txt plain.txt',
      'new file mode 100644',
      '--- /dev/null',
      '+++ plain.txt',
      '@@ -0,0 +1,2 @@',
      '+++ looks like header',
      '+x',
      'diff --git with space.txt with space.txt',
      '--- /dev/null',
      '+++ with space.txt\t',
      '@@ -0,0 +1 @@',
      '+a',
      'diff --git "tab\\there.txt" "tab\\there.txt"',
      '--- /dev/null',
      '+++ "tab\\there.txt"',
      '@@ -0,0 +1 @@',
      '+t',
      'diff --git gone.txt gone.txt',
      'deleted file mode 100644',
      '--- gone.txt',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-bye',
    ].join('\n');
    expect([...parseDiffAdded(diff)]).toEqual([
      ['plain.txt', [{ n: 1, text: '++ looks like header' }, { n: 2, text: 'x' }]],
      ['with space.txt', [{ n: 1, text: 'a' }]],
      ['tab\there.txt', [{ n: 1, text: 't' }]],
    ]);
  });

  it('tracks new-file line numbers across hunks', () => {
    const diff = ['diff --git f f', '--- f', '+++ f', '@@ -3,0 +4,2 @@', '+a', '+b', '@@ -10 +12 @@', '-old', '+new'].join('\n');
    expect(parseDiffAdded(diff).get('f')).toEqual([
      { n: 4, text: 'a' },
      { n: 5, text: 'b' },
      { n: 12, text: 'new' },
    ]);
  });

  it('round-trips line ranges', () => {
    expect(toRanges([9, 3, 4, 5, 11, 12])).toBe('3-5,9,11-12');
    expect(fromRanges('3-5,9,11-12')).toEqual([3, 4, 5, 9, 11, 12]);
    expect(fromRanges('')).toEqual([]);
  });
});

describe('cost', () => {
  const table = loadPricing();
  const ev = (model: string, input: number) => ({ timestamp: '', model, usage: { input, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 } });

  it('matches prefixed and dated model ids', () => {
    expect(priceFor('claude-opus-5-5-20261001', table)?.input).toBe(4);
    expect(priceFor('anthropic.claude-opus-5-5', table)?.input).toBe(4);
    expect(priceFor('us.anthropic.claude-sonnet-5-5', table)?.input).toBe(2);
    expect(priceFor('models/gemini-2.5-pro', table)?.input).toBe(1.25);
    expect(priceFor('claude-opus-5', table)?.input).toBe(5);
    expect(priceFor('mystery-model', table)).toBeNull();
  });

  it('is null without usage data and low-confidence with unpriced models', () => {
    expect(costOf([], table, false)).toEqual({ amount: null, confidence: 'low', unpricedModels: [] });
    expect(costOf([ev('mystery', 1e6)], table, true)).toEqual({ amount: null, confidence: 'low', unpricedModels: ['mystery'] });
    expect(costOf([ev('gpt-5.4', 1e6), ev('mystery', 10)], table, true)).toEqual({ amount: 2.5, confidence: 'low', unpricedModels: ['mystery'] });
    expect(costOf([ev('gpt-5.4', 1e6)], table, true)).toEqual({ amount: 2.5, confidence: 'high', unpricedModels: [] });
  });

  it('marks costs that use derived prices as medium and applies 1h cache-write rates', () => {
    const e = { timestamp: '', model: 'claude-opus-5-5', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 1e6, cacheWrite1h: 1e6 } };
    expect(costOf([e], table, true)).toEqual({ amount: 13, confidence: 'medium', unpricedModels: [] });
  });

  it('applies user overrides and labels the pricing version', () => {
    const t = loadPricing({ 'mystery-model': { input: 1, output: 2, cacheRead: 0, cacheWrite: 1, cacheWrite1h: 1 }, 'gpt-5.4': { input: 3 } });
    expect(t.version).toMatch(/\+2-overrides$/);
    expect(priceFor('mystery-model', t)?.output).toBe(2);
    expect(priceFor('gpt-5.4', t)?.input).toBe(3);
  });
});

describe('summarize', () => {
  it('collapses whitespace, truncates, and counts extra prompts', () => {
    expect(summarize([])).toBeNull();
    expect(summarize(['a\n  b', 'c'])).toBe('a b (+1 more)');
    expect(summarize(['x'.repeat(200)])!.length).toBe(140);
  });
});

describe('shell command signals', () => {
  it.each(['git commit -m x', 'git add -A && git commit -qm "y"', 'git -C ../repo commit --amend --no-edit', 'GIT_AUTHOR_DATE=x git commit -m z'])(
    'detects commit: %s',
    (c) => expect(isGitCommit(c)).toBe(true),
  );
  it.each(['git commit --dry-run', 'git log --grep commit', 'echo git commit', 'git show HEAD'])('ignores: %s', (c) =>
    expect(isGitCommit(c)).toBe(false),
  );
  it.each(["echo hi > out.txt", 'cat <<EOF >> notes.md', "sed -i '' s/a/b/ f", 'python3 gen.py', 'npx prettier --write .', 'cp a b', 'git checkout -- f'])(
    'may write files: %s',
    (c) => expect(mayWriteFiles(c)).toBe(true),
  );
  it.each(['npm test', 'git status', 'ls -la', 'cat README.md', 'grep -r foo src 2>/dev/null', 'rg x > /dev/null', 'node --version'])(
    'read-only: %s',
    (c) => expect(mayWriteFiles(c)).toBe(false),
  );
});

describe('effectiveCwd', () => {
  it('follows leading cd and git -C, resolving ~ and relative paths', () => {
    const abs = (p: string) => path.resolve(p);
    expect(effectiveCwd('npm test', '/w/a', '/h')).toBe('/w/a');
    expect(effectiveCwd('cd ~/repo-b && git commit -m x', '/w/a', abs('/h'))).toBe(abs('/h/repo-b'));
    expect(effectiveCwd('cd sub; cd ../c && make test', abs('/w/a'), '/h')).toBe(abs('/w/a/c'));
    expect(effectiveCwd(`git -C "${abs('/w/other repo')}" commit -m x`, '/w/a', '/h')).toBe(abs('/w/other repo'));
    expect(effectiveCwd('cd rel && ls', null, '/h')).toBeNull();
  });
});

describe('ignored paths', () => {
  it.each([
    ['**/package-lock.json', 'package-lock.json', true],
    ['**/package-lock.json', 'apps/web/package-lock.json', true],
    ['**/dist/**', 'packages/x/dist/index.js', true],
    ['**/dist/**', 'src/distance.ts', false],
    ['**/*.min.js', 'public/vendor.min.js', true],
    ['docs/*.md', 'docs/a.md', true],
    ['docs/*.md', 'docs/sub/a.md', false],
  ])('%s matches %s: %s', (glob, file, expected) => expect(globToRegExp(glob).test(file)).toBe(expected));
});

describe('Windows path handling', () => {
  it('canonicalizes drive letters, separators and case', () => {
    expect(canonical('C:\\Users\\Dev\\Repo\\', 'win32')).toBe('c:/users/dev/repo');
    expect(canonical('C:\\', 'win32')).toBe('c:/');
    expect(canonical('/Users/Dev/Repo/', 'darwin')).toBe('/Users/Dev/Repo');
  });

  it('matches files under a repo regardless of how each tool spelled the path', () => {
    const root = canonical('C:/Users/Dev/Repo', 'win32');
    const fromAgent = canonical('c:\\users\\dev\\repo\\src\\App.tsx', 'win32');
    expect(isUnder(fromAgent, root)).toBe(true);
    expect(relTo(root, fromAgent)).toBe('src/app.tsx');
    expect(isUnder(canonical('C:\\Users\\Dev\\Repo2\\x', 'win32'), root)).toBe(false);
  });

  it('recognizes test and commit commands written for cmd/PowerShell', () => {
    expect(isGitCommit('git commit -m "x"')).toBe(true);
    expect(isTestCommand('npm.cmd test')).toBe(true);
    expect(isTestCommand('pytest.exe -q')).toBe(true);
    expect(isTestCommand('.\\gradlew.bat test')).toBe(true);
    expect(isTestCommand('npm test')).toBe(true);
  });
});

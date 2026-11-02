import { beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { attributeCommit } from '../src/attribute.js';
import { createAdapters } from '../src/adapters/index.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { loadPricing } from '../src/cost.js';
import { readReceipt, writeReceipt } from '../src/notes.js';
import { buildReport, type ReportData } from '../src/report/data.js';
import { renderHtml } from '../src/report/html.js';
import { at, claudeSession, commitAt, gitIn, initRepo, tmpDir, write } from './helpers.js';

const NOW = new Date('2026-11-01T12:00:00Z');
const T0 = new Date(NOW.getTime() - 30 * 86_400_000);

describe('report', () => {
  const home = tmpDir('rephome');
  const repo = tmpDir('report');
  let data: ReportData;

  beforeAll(async () => {
    process.env.RCPT_HOME = tmpDir('reprcpt');
    initRepo(repo);
    write(path.join(repo, 'README.md'), '# r\n');
    commitAt(repo, at(T0, -60), 'init');

    // c1: Claude writes 4 lines of a.js.
    claudeSession(home, {
      id: 'rep-1',
      cwd: repo,
      events: [
        { t: at(T0, 1), kind: 'prompt', text: 'write a.js' },
        { t: at(T0, 2), kind: 'write', path: path.join(repo, 'a.js'), content: 'const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\n' },
        { t: at(T0, 3), kind: 'bash', command: 'npm test', exitCode: 0 },
      ],
    });
    write(path.join(repo, 'a.js'), 'const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\n');
    const c1 = commitAt(repo, at(T0, 5), 'ai: add a.js');

    // c2 (a day later): a human rewrites one AI line and adds a file.
    write(path.join(repo, 'a.js'), 'const a = 1;\nconst b = 20;\nconst c = 3;\nconst d = 4;\n');
    write(path.join(repo, 'h.txt'), 'human one\nhuman two\n');
    const c2 = commitAt(repo, at(T0, 24 * 60), 'human <script>alert(1)</script> tweak');

    // c3 (20 days in): human change outside c2's 14-day window; itself too recent to measure.
    write(path.join(repo, 'h.txt'), 'human ONE\nhuman two\n');
    const c3 = commitAt(repo, at(T0, 20 * 24 * 60), 'human later');

    // c4: no receipt at all.
    write(path.join(repo, 'x.txt'), 'x\n');
    commitAt(repo, at(T0, 25 * 24 * 60), 'no receipt');

    const opts = { adapters: createAdapters({ home, env: {} }), config: DEFAULT_CONFIG, pricing: loadPricing() };
    for (const sha of [c1, c2, c3]) await writeReceipt(repo, sha, await attributeCommit({ repoDir: repo, rev: sha, ...opts }));
    data = buildReport(repo, { since: at(T0, -120), rewriteDays: 14, maxRewriteCommits: 100, now: NOW });
  });

  it('counts commits, never assuming missing receipts are human', () => {
    expect(data.commits).toEqual({ total: 5, merges: 0, withReceipt: 3, withoutReceipt: 2, aiAssisted: 1 });
  });

  it('computes AI share over attributable lines', () => {
    expect(data.lines).toMatchObject({ ai: 4, unknown: 0 });
    expect(data.lines.human).toBe(4); // c2: 1 (a.js) + 2 (h.txt); c3: 1
    expect(data.lines.aiShare).toBeCloseTo(0.5);
  });

  it('splits spend and lines per agent', () => {
    expect(data.agents).toEqual([expect.objectContaining({ agent: 'claude-code', commits: 1, aiLines: 4, models: ['claude-opus-5-5'] })]);
    expect(data.agents[0]!.spend).toBeGreaterThan(0);
    expect(data.spend.perAiCommit).toBeCloseTo(data.spend.total);
  });

  it('reports test coverage of AI commits', () => {
    expect(data.tests).toEqual({ aiCommits: 1, withTests: 1, passed: 1, failed: 0, unknown: 0, passRate: 1 });
  });

  it('measures rewrite rate with git blame --reverse, AI vs human baseline', () => {
    expect(data.rewrite.ai).toEqual({ lines: 4, rewritten: 1, rate: 0.25 });
    expect(data.rewrite.human).toEqual({ lines: 3, rewritten: 0, rate: 0 });
    expect(data.rewrite.commitsMeasured).toBe(2);
    expect(data.rewrite.commitsTooRecent).toBe(1);
  });

  it('renders a self-contained, escaped HTML file with dark mode', () => {
    const html = renderHtml(data);
    expect(html).not.toMatch(/(src|href)=["']?(https?:)?\/\//);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('prefers-color-scheme:dark');
    expect(html).toContain('How these numbers are computed');
    expect(html).toContain('no receipt');
    expect(html.match(/<script>/g)).toHaveLength(1); // only our tooltip script
  });
});

describe('notes without a configured git identity', () => {
  it('falls back to an rcpt identity instead of failing (fresh machines, CI)', async () => {
    const repo = tmpDir('noident');
    initRepo(repo);
    write(path.join(repo, 'a.txt'), 'a\n');
    const sha = commitAt(repo, new Date('2026-10-01T00:00:00Z'), 'a');
    gitIn(repo, ['config', 'user.useConfigOnly', 'true']);
    const saved = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_NOSYSTEM };
    process.env.GIT_CONFIG_GLOBAL = path.join(tmpDir('emptycfg'), 'none');
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    for (const k of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) delete process.env[k];
    try {
      const r = await attributeCommit({ repoDir: repo, rev: sha, adapters: [], config: DEFAULT_CONFIG, pricing: loadPricing() });
      await writeReceipt(repo, sha, r);
      expect(readReceipt(repo, sha)?.commitSha).toBe(sha);
      expect(gitIn(repo, ['log', '-1', '--format=%an <%ae>', 'refs/notes/rcpt']).trim()).toBe('rcpt <rcpt@localhost>');
    } finally {
      process.env.GIT_CONFIG_GLOBAL = saved.g;
      if (saved.s === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
      else process.env.GIT_CONFIG_NOSYSTEM = saved.s;
    }
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { badgeMarkdown, COMMENT_MARKER, summarizePr } from '../src/pr-summary.js';
import { writeReceipt } from '../src/notes.js';
import type { Receipt } from '../src/types.js';
import { commitAt, gitIn, initRepo, tmpDir, write } from './helpers.js';

const ACTION = path.resolve(import.meta.dirname, '..', 'action', 'dist', 'index.js');

function receipt(sha: string, o: Partial<Receipt> & { ai?: number; total?: number; unknown?: number } = {}): Receipt {
  const ai = o.ai ?? 0;
  return {
    schemaVersion: 1,
    commitSha: sha,
    aiAssisted: o.aiAssisted ?? ai > 0,
    confidence: o.confidence ?? (ai > 0 ? 'high' : null),
    sessions: o.sessions ?? (ai > 0 ? [{ id: 's', agent: 'claude-code', agentVersion: '2', models: ['claude-opus-5-5'], confidence: 'high', evidence: ['line-match'], aiLinesAdded: ai, estimatedCostUsd: 0.5 }] : []),
    promptSummary: null,
    filesAttributed: [],
    totals: { aiLinesAdded: ai, totalLinesAdded: o.total ?? 10, unknownLines: o.unknown ?? 0, ignoredLines: 0 },
    testsRun: o.testsRun ?? { status: ai > 0 ? 'passed' : 'none', command: ai > 0 ? 'npm test' : null },
    estimatedCostUsd: o.estimatedCostUsd ?? { amount: ai > 0 ? 0.5 : null, pricingVersion: 'x', confidence: 'high', unpricedModels: [] },
    humanEditedAfterAi: null,
    isMerge: false,
    createdAt: '',
    generator: { name: 'rcpt', version: '0' },
  };
}

describe('summarizePr', () => {
  it('builds the headline and never treats missing receipts as human', () => {
    const commits = ['a', 'b', 'c', 'd'].map((s) => ({ sha: s.repeat(40), subject: `commit ${s}` }));
    const receipts = new Map<string, Receipt>([
      ['a'.repeat(40), receipt('a'.repeat(40), { ai: 8, total: 10 })],
      [
        'b'.repeat(40),
        receipt('b'.repeat(40), {
          ai: 5,
          total: 10,
          sessions: [{ id: 'x', agent: 'codex', agentVersion: '1', models: ['gpt-6-luna'], confidence: 'medium', evidence: ['file-match'], aiLinesAdded: 5, estimatedCostUsd: 0.62 }],
          estimatedCostUsd: { amount: 0.62, pricingVersion: 'x', confidence: 'high', unpricedModels: [] },
        }),
      ],
      ['c'.repeat(40), receipt('c'.repeat(40), { ai: 0, total: 5 })],
    ]);
    const s = summarizePr(commits, receipts);
    expect(s.headline).toBe('🧾 rcpt: 2 of 4 commits AI-assisted · claude-code, codex · 52% of added lines · tests ✅ · est. $1.12 · 1 without receipt');
    expect(s.body.startsWith(COMMENT_MARKER)).toBe(true);
    expect(s.body).toContain('| `ddddddd` | commit d | no receipt |');
  });

  it('flags failed tests, unknown cost and escapes markdown in subjects', () => {
    const sha = 'e'.repeat(40);
    const r = receipt(sha, { ai: 3, testsRun: { status: 'failed', command: 'npm test' }, estimatedCostUsd: { amount: null, pricingVersion: 'x', confidence: 'low', unpricedModels: [] } });
    const s = summarizePr([{ sha, subject: 'fix | table *bold*' }], new Map([[sha, r]]));
    expect(s.headline).toContain('tests ❌');
    expect(s.headline).not.toContain('est.');
    expect(s.body).toContain('fix \\| table \\*bold\\*');
    const partial = receipt(sha, { ai: 7, total: 10, unknown: 3 });
    expect(summarizePr([{ sha, subject: 'p' }], new Map([[sha, partial]])).body).toContain('| 7+? / 10 |');
  });

  it('makes a shields.io badge', () => {
    expect(badgeMarkdown(0.684)).toBe('![AI-written lines: 68%](https://img.shields.io/badge/AI--written%20lines-68%25-2a78d6)');
    expect(badgeMarkdown(null)).toContain('n%2Fa');
  });
});

describe('GitHub Action (bundled) against a mock API', () => {
  let server: http.Server;
  let base = '';
  const comments: { id: number; body: string }[] = [];
  const requests: string[] = [];
  let ws = '';
  const shas: string[] = [];

  beforeAll(async () => {
    // A repo with receipts pushed to a bare remote; the workspace is a fresh clone without notes.
    const src = tmpDir('act-src');
    initRepo(src);
    write(path.join(src, 'a.txt'), 'a\n');
    shas.push(commitAt(src, new Date('2026-10-01T00:00:00Z'), 'one'));
    write(path.join(src, 'b.txt'), 'b\n');
    shas.push(commitAt(src, new Date('2026-10-02T00:00:00Z'), 'two'));
    await writeReceipt(src, shas[0]!, receipt(shas[0]!, { ai: 6, total: 8 }));
    const remote = path.join(tmpDir('act-remote'), 'r.git');
    gitIn(path.dirname(remote), ['init', '-q', '--bare', remote]);
    gitIn(src, ['push', '-q', remote, 'main', 'refs/notes/rcpt']);
    ws = path.join(tmpDir('act-ws'), 'ws');
    gitIn(path.dirname(ws), ['clone', '-q', '--depth', '1', remote, ws]);

    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        requests.push(`${req.method} ${req.url}`);
        res.setHeader('content-type', 'application/json');
        if (req.url?.startsWith('/repos/o/r/pulls/7/commits')) return res.end(JSON.stringify(shas.map((sha, i) => ({ sha, commit: { message: i ? 'two' : 'one\n\nbody' } }))));
        if (req.url?.startsWith('/repos/o/r/issues/7/comments') && req.method === 'GET') return res.end(JSON.stringify(comments));
        if (req.url === '/repos/o/r/issues/7/comments' && req.method === 'POST') {
          comments.push({ id: 99, body: JSON.parse(body).body });
          res.statusCode = 201;
          return res.end('{}');
        }
        if (req.url === '/repos/o/r/issues/comments/99' && req.method === 'PATCH') {
          comments[0]!.body = JSON.parse(body).body;
          return res.end('{}');
        }
        res.statusCode = 404;
        res.end('{}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  function runAction(): Promise<{ code: number; out: string }> {
    const event = path.join(tmpDir('evt'), 'event.json');
    fs.writeFileSync(event, JSON.stringify({ pull_request: { number: 7 } }));
    const summary = path.join(path.dirname(event), 'summary.md');
    return new Promise((resolve) => {
      const p = spawn(process.execPath, [ACTION], {
        cwd: ws,
        env: { ...process.env, GITHUB_API_URL: base, GITHUB_REPOSITORY: 'o/r', GITHUB_EVENT_PATH: event, GITHUB_WORKSPACE: ws, 'INPUT_GITHUB-TOKEN': 't', GITHUB_STEP_SUMMARY: summary },
      });
      let out = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (out += d));
      p.on('close', (code) => resolve({ code: code ?? 1, out }));
    });
  }

  it('posts one comment, then updates it instead of duplicating', async () => {
    const first = await runAction();
    expect(first.code, first.out).toBe(0);
    expect(first.out).toContain('🧾 rcpt: 1 of 2 commits AI-assisted · claude-code · 75% of added lines · tests ✅ · est. $0.50 · 1 without receipt');
    expect(comments).toHaveLength(1);
    const second = await runAction();
    expect(second.code, second.out).toBe(0);
    expect(comments).toHaveLength(1);
    expect(requests.filter((r) => r.startsWith('POST'))).toHaveLength(1);
    expect(requests.filter((r) => r.startsWith('PATCH'))).toHaveLength(1);
    expect(comments[0]!.body).toContain(COMMENT_MARKER);
  });
});

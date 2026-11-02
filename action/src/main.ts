// rcpt GitHub Action: summarize receipts for a pull request's commits in one PR comment (created once, then updated).
// Bundled into action/dist/index.js with no runtime dependencies.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { readAllReceipts } from '../../src/notes.js';
import { COMMENT_MARKER, summarizePr, type PrCommit } from '../../src/pr-summary.js';

const input = (name: string, fallback = '') => process.env[`INPUT_${name.toUpperCase().replace(/ /g, '_')}`]?.trim() || fallback;
const api = process.env.GITHUB_API_URL || 'https://api.github.com';

function setOutput(name: string, value: string) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}<<__RCPT__\n${value}\n__RCPT__\n`);
}

async function gh<T>(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; data: T; next: string | null }> {
  const res = await fetch(path.startsWith('http') ? path : `${api}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '')?.[1] ?? null;
  const data = (res.status === 204 ? null : await res.json().catch(() => null)) as T;
  return { status: res.status, data, next };
}

async function all<T>(token: string, path: string): Promise<T[]> {
  const out: T[] = [];
  for (let url: string | null = `${path}${path.includes('?') ? '&' : '?'}per_page=100`; url; ) {
    const r: { status: number; data: T[]; next: string | null } = await gh<T[]>(token, 'GET', url);
    if (r.status >= 400) throw new Error(`GET ${url} failed: HTTP ${r.status}`);
    out.push(...r.data);
    url = r.next;
  }
  return out;
}

async function run() {
  const token = input('github-token');
  const repo = process.env.GITHUB_REPOSITORY!;
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH!, 'utf8')) as { pull_request?: { number: number }; number?: number };
  const pr = event.pull_request?.number ?? event.number;
  if (!pr) {
    console.log('rcpt: not a pull_request event; nothing to do.');
    return;
  }
  const cwd = process.env.GITHUB_WORKSPACE || process.cwd();
  const remote = input('remote', 'origin');

  // Receipts live in git notes. Fetch them (a glob refspec never fails when no notes exist yet).
  try {
    execFileSync('git', ['fetch', '--no-tags', '--quiet', remote, `+refs/notes/rcpt*:refs/notes/remotes/${remote}/rcpt*`], { cwd, stdio: 'inherit' });
  } catch {
    console.log('::warning::rcpt: could not fetch refs/notes/rcpt; every commit will show "no receipt".');
  }
  const receipts = readAllReceipts(cwd);

  const commits = (await all<{ sha: string; commit: { message: string } }>(token, `/repos/${repo}/pulls/${pr}/commits`)).map(
    (c): PrCommit => ({ sha: c.sha, subject: c.commit.message.split('\n')[0] ?? '' }),
  );
  const summary = summarizePr(commits, receipts);
  console.log(summary.headline);
  setOutput('summary', summary.headline);
  setOutput('ai-assisted-commits', String(summary.stats.aiAssisted));
  setOutput('ai-share', summary.stats.aiShare === null ? '' : summary.stats.aiShare.toFixed(4));
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary.body + '\n');

  if (input('comment', 'true') !== 'true') return;
  const existing = (await all<{ id: number; body?: string; user?: { type?: string } }>(token, `/repos/${repo}/issues/${pr}/comments`)).find((c) =>
    c.body?.includes(COMMENT_MARKER),
  );
  const res = existing
    ? await gh(token, 'PATCH', `/repos/${repo}/issues/comments/${existing.id}`, { body: summary.body })
    : await gh(token, 'POST', `/repos/${repo}/issues/${pr}/comments`, { body: summary.body });
  if (res.status === 403 || res.status === 404) {
    // Typical for pull requests from forks: the token is read-only. The job summary still has the report.
    console.log(`::warning::rcpt: no permission to comment on this PR (HTTP ${res.status}); see the job summary instead.`);
  } else if (res.status >= 400) {
    throw new Error(`commenting failed: HTTP ${res.status}`);
  } else {
    console.log(existing ? `rcpt: updated comment ${existing.id}` : 'rcpt: posted comment');
  }
}

run().catch((err: unknown) => {
  console.log(`::error::rcpt: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});

import path from 'node:path';
import { fromRanges } from '../attribute.js';
import { commitAddedLines, git, repoRoot } from '../git.js';
import { readAllReceipts } from '../notes.js';
import { normalizeLine } from '../util/lines.js';
import type { Confidence, Receipt } from '../types.js';
import { VERSION } from '../version.js';

export interface ReportOptions {
  since: Date;
  /** AI lines changed or deleted within this many days count as rewritten. */
  rewriteDays: number;
  /** Cap on commits measured for rewrite rate (each costs a few `git blame` calls). */
  maxRewriteCommits: number;
  now?: Date;
}

export interface CommitRow {
  sha: string;
  date: string;
  subject: string;
  receipt: Receipt | null;
}

interface LineRate {
  lines: number;
  rewritten: number;
  rate: number | null;
}

export interface ReportData {
  repo: string;
  generatedAt: string;
  since: string;
  rcptVersion: string;
  pricingVersions: string[];
  commits: { total: number; merges: number; withReceipt: number; withoutReceipt: number; aiAssisted: number };
  /** Added lines in commits that have receipts. human = total - ai - unknown. */
  lines: { ai: number; human: number; unknown: number; ignored: number; total: number; aiShare: number | null };
  weekly: { week: string; ai: number; human: number; unknown: number; commits: number; aiCommits: number; noReceipt: number }[];
  agents: { agent: string; models: string[]; commits: number; aiLines: number; spend: number; unknownSpendCommits: number; costPerCommit: number | null }[];
  spend: { total: number; perAiCommit: number | null; aiCommitsWithUnknownCost: number; unpricedModels: string[]; lowestConfidence: Confidence | null };
  tests: { aiCommits: number; withTests: number; passed: number; failed: number; unknown: number; passRate: number | null };
  rewrite: { days: number; ai: LineRate; human: LineRate; commitsMeasured: number; commitsTooRecent: number; capped: boolean };
  linkConfidence: Record<Confidence, number>;
  rows: CommitRow[];
}

const RANK: Record<Confidence, number> = { low: 1, medium: 2, high: 3 };

function weekOf(iso: string): string {
  const d = new Date(iso);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)).toISOString().slice(0, 10);
}

export function buildReport(cwd: string, o: ReportOptions): ReportData {
  const root = repoRoot(cwd);
  const now = o.now ?? new Date();
  const receipts = readAllReceipts(root);
  const log = git(root, ['log', '--format=%H%x00%aI%x00%P%x00%s', `--since=${o.since.toISOString()}`, 'HEAD', '--']);
  const all = log
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [sha, date, parents, subject] = l.split('\0');
      return { sha: sha!, date: date!, merge: (parents ?? '').split(' ').filter(Boolean).length > 1, subject: subject ?? '' };
    });
  const rows: CommitRow[] = all.filter((c) => !c.merge).map((c) => ({ sha: c.sha, date: c.date, subject: c.subject, receipt: receipts.get(c.sha) ?? null }));

  const data: ReportData = {
    repo: path.basename(root),
    generatedAt: now.toISOString(),
    since: o.since.toISOString(),
    rcptVersion: VERSION,
    pricingVersions: [],
    commits: { total: all.length, merges: all.length - rows.length, withReceipt: 0, withoutReceipt: 0, aiAssisted: 0 },
    lines: { ai: 0, human: 0, unknown: 0, ignored: 0, total: 0, aiShare: null },
    weekly: [],
    agents: [],
    spend: { total: 0, perAiCommit: null, aiCommitsWithUnknownCost: 0, unpricedModels: [], lowestConfidence: null },
    tests: { aiCommits: 0, withTests: 0, passed: 0, failed: 0, unknown: 0, passRate: null },
    rewrite: { days: o.rewriteDays, ai: { lines: 0, rewritten: 0, rate: null }, human: { lines: 0, rewritten: 0, rate: null }, commitsMeasured: 0, commitsTooRecent: 0, capped: false },
    linkConfidence: { high: 0, medium: 0, low: 0 },
    rows,
  };

  const weeks = new Map<string, ReportData['weekly'][number]>();
  const agents = new Map<string, ReportData['agents'][number] & { modelSet: Set<string> }>();
  const pricing = new Set<string>();
  const unpriced = new Set<string>();

  for (const row of rows) {
    const w = weekOf(row.date);
    const wk = weeks.get(w) ?? { week: w, ai: 0, human: 0, unknown: 0, commits: 0, aiCommits: 0, noReceipt: 0 };
    weeks.set(w, wk);
    wk.commits++;
    const r = row.receipt;
    if (!r) {
      data.commits.withoutReceipt++;
      wk.noReceipt++;
      continue;
    }
    data.commits.withReceipt++;
    pricing.add(r.estimatedCostUsd.pricingVersion);
    const human = r.totals.totalLinesAdded - r.totals.aiLinesAdded - r.totals.unknownLines;
    data.lines.ai += r.totals.aiLinesAdded;
    data.lines.unknown += r.totals.unknownLines;
    data.lines.ignored += r.totals.ignoredLines ?? 0;
    data.lines.human += human;
    wk.ai += r.totals.aiLinesAdded;
    wk.unknown += r.totals.unknownLines;
    wk.human += human;
    if (r.confidence) data.linkConfidence[r.confidence]++;
    if (!r.aiAssisted) continue;

    data.commits.aiAssisted++;
    wk.aiCommits++;
    const cost = r.estimatedCostUsd;
    if (cost.amount === null) data.spend.aiCommitsWithUnknownCost++;
    else data.spend.total += cost.amount;
    for (const m of cost.unpricedModels) unpriced.add(m);
    if (!data.spend.lowestConfidence || RANK[cost.confidence] < RANK[data.spend.lowestConfidence]) data.spend.lowestConfidence = cost.confidence;

    data.tests.aiCommits++;
    if (r.testsRun.status !== 'none') data.tests.withTests++;
    if (r.testsRun.status === 'passed') data.tests.passed++;
    if (r.testsRun.status === 'failed') data.tests.failed++;
    if (r.testsRun.status === 'unknown') data.tests.unknown++;

    const seen = new Set<string>();
    for (const s of r.sessions.filter((x) => x.confidence !== 'low')) {
      const a = agents.get(s.agent) ?? { agent: s.agent, models: [], modelSet: new Set<string>(), commits: 0, aiLines: 0, spend: 0, unknownSpendCommits: 0, costPerCommit: null };
      agents.set(s.agent, a);
      if (!seen.has(s.agent)) a.commits++;
      seen.add(s.agent);
      for (const m of s.models) a.modelSet.add(m);
      a.aiLines += s.aiLinesAdded ?? 0;
      if (s.estimatedCostUsd === null || s.estimatedCostUsd === undefined) a.unknownSpendCommits++;
      else a.spend += s.estimatedCostUsd;
    }
  }

  data.lines.total = data.lines.ai + data.lines.human + data.lines.unknown;
  const attributable = data.lines.ai + data.lines.human;
  data.lines.aiShare = attributable ? data.lines.ai / attributable : null;
  data.weekly = [...weeks.values()].sort((a, b) => a.week.localeCompare(b.week));
  data.agents = [...agents.values()]
    .map(({ modelSet, ...a }) => ({ ...a, models: [...modelSet].sort(), costPerCommit: a.commits - a.unknownSpendCommits > 0 ? a.spend / (a.commits - a.unknownSpendCommits) : null }))
    .sort((a, b) => b.commits - a.commits || a.agent.localeCompare(b.agent));
  const priced = data.commits.aiAssisted - data.spend.aiCommitsWithUnknownCost;
  data.spend.perAiCommit = priced > 0 ? data.spend.total / priced : null;
  data.spend.unpricedModels = [...unpriced].sort();
  data.tests.passRate = data.tests.aiCommits ? data.tests.passed / data.tests.aiCommits : null;
  data.pricingVersions = [...pricing].sort();
  data.rewrite = measureRewrites(root, rows, o, now);
  return data;
}

/**
 * For each commit at least `days` old, follow its added lines forward with `git blame --reverse` to the last
 * first-parent commit within `days`. A line that doesn't survive to that commit was changed or deleted.
 * Whitespace-only changes don't count (-w). AI lines come from the receipt; human lines are the rest.
 */
function measureRewrites(root: string, rows: CommitRow[], o: ReportOptions, now: Date): ReportData['rewrite'] {
  const out: ReportData['rewrite'] = { days: o.rewriteDays, ai: { lines: 0, rewritten: 0, rate: null }, human: { lines: 0, rewritten: 0, rate: null }, commitsMeasured: 0, commitsTooRecent: 0, capped: false };
  const ms = o.rewriteDays * 86_400_000;
  const eligible = rows.filter((r) => r.receipt && !r.receipt.isMerge && r.receipt.totals.totalLinesAdded > 0);
  const old = eligible.filter((r) => Date.parse(r.date) + ms <= now.getTime());
  out.commitsTooRecent = eligible.length - old.length;
  const measured = old.slice(0, o.maxRewriteCommits);
  out.capped = old.length > measured.length;

  for (const row of measured) {
    const r = row.receipt!;
    let target: string;
    try {
      target = git(root, ['rev-list', '-1', '--first-parent', `--before=${new Date(Date.parse(row.date) + ms).toISOString()}`, 'HEAD']).trim();
      if (!target) continue;
      git(root, ['merge-base', '--is-ancestor', row.sha, target]);
    } catch {
      continue; // not on the first-parent line of HEAD
    }
    const added = commitAddedLines(root, row.sha);
    for (const f of r.filesAttributed) {
      if (f.aiLinesAdded === null) continue;
      const aiSet = new Set(f.aiLines ? fromRanges(f.aiLines) : []);
      const lines = (added.get(f.path) ?? []).filter((l) => normalizeLine(l.text) !== null).map((l) => l.n);
      if (!lines.length) continue;
      const survivors = survivingLines(root, row.sha, target, f.path);
      for (const n of lines) {
        const bucket = aiSet.has(n) ? out.ai : out.human;
        bucket.lines++;
        if (!survivors.has(n)) bucket.rewritten++;
      }
    }
    out.commitsMeasured++;
  }
  for (const b of [out.ai, out.human]) b.rate = b.lines ? b.rewritten / b.lines : null;
  return out;
}

/** Line numbers (in `sha`'s version of `file`) that still exist unchanged at `target`. */
function survivingLines(root: string, sha: string, target: string, file: string): Set<number> {
  const keep = new Set<number>();
  if (sha === target) {
    // Nothing happened in the window: every line survived.
    const n = git(root, ['show', `${sha}:${file}`]).split('\n').length;
    for (let i = 1; i <= n; i++) keep.add(i);
    return keep;
  }
  let out: string;
  try {
    out = git(root, ['blame', '--reverse', '-w', '--porcelain', `${sha}..${target}`, '--', file]);
  } catch {
    return keep; // file gone or unreadable: treat as not surviving
  }
  const targetShort = target;
  for (const line of out.split('\n')) {
    const m = /^([0-9a-f]{40}) \d+ (\d+)/.exec(line);
    if (m && m[1] === targetShort) keep.add(Number(m[2]));
  }
  return keep;
}

import type { Receipt } from './types.js';

export const COMMENT_MARKER = '<!-- rcpt:pr-summary -->';

export interface PrCommit {
  sha: string;
  subject: string;
}

export interface PrSummary {
  /** One line, e.g. "🧾 rcpt: 3 of 4 commits AI-assisted · claude-code, codex · 68% of added lines · tests ✅ · est. $1.12" */
  headline: string;
  /** Full comment body (markdown), including the marker used to find and update it. */
  body: string;
  stats: { commits: number; withReceipt: number; aiAssisted: number; aiShare: number | null; costUsd: number | null; tests: 'passed' | 'failed' | 'partial' | 'none' };
}

const usd = (n: number) => (n > 0 && n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`);
const mdEscape = (s: string) => s.replace(/[\\`*_[\]<>|]/g, '\\$&');

export function summarizePr(commits: PrCommit[], receipts: Map<string, Receipt>): PrSummary {
  const rows = commits.map((c) => ({ ...c, r: receipts.get(c.sha) ?? null }));
  const withReceipt = rows.filter((x) => x.r && !x.r.isMerge);
  const ai = withReceipt.filter((x) => x.r!.aiAssisted);
  const agents = [...new Set(ai.flatMap((x) => x.r!.sessions.filter((s) => s.confidence !== 'low').map((s) => s.agent)))].sort();

  let aiLines = 0;
  let known = 0;
  for (const x of withReceipt) {
    aiLines += x.r!.totals.aiLinesAdded;
    known += x.r!.totals.totalLinesAdded - x.r!.totals.unknownLines;
  }
  const aiShare = known ? aiLines / known : null;

  const statuses = ai.map((x) => x.r!.testsRun.status);
  const tests: PrSummary['stats']['tests'] = !ai.length || statuses.every((s) => s === 'none')
    ? 'none'
    : statuses.includes('failed')
      ? 'failed'
      : statuses.every((s) => s === 'passed')
        ? 'passed'
        : 'partial';

  const costs = ai.map((x) => x.r!.estimatedCostUsd.amount);
  const costUsd = costs.some((c) => c !== null) ? costs.reduce<number>((a, c) => a + (c ?? 0), 0) : null;
  const costPartial = costUsd !== null && costs.some((c) => c === null);

  const parts = [`🧾 rcpt: ${ai.length} of ${rows.length} commit${rows.length === 1 ? '' : 's'} AI-assisted`];
  if (agents.length) parts.push(agents.join(', '));
  if (aiShare !== null) parts.push(`${Math.round(aiShare * 100)}% of added lines`);
  if (ai.length) parts.push(`tests ${{ passed: '✅', failed: '❌', partial: '⚠️', none: '—' }[tests]}`);
  if (costUsd !== null) parts.push(`est. ${usd(costUsd)}${costPartial ? '+' : ''}`);
  const missing = rows.length - withReceipt.length - rows.filter((x) => x.r?.isMerge).length;
  if (missing) parts.push(`${missing} without receipt`);
  const headline = parts.join(' · ');

  const table = rows
    .map((x) => {
      const short = `\`${x.sha.slice(0, 7)}\``;
      const subj = mdEscape(x.subject.length > 60 ? x.subject.slice(0, 59) + '…' : x.subject);
      const r = x.r;
      if (!r) return `| ${short} | ${subj} | no receipt | | | |`;
      if (r.isMerge) return `| ${short} | ${subj} | merge | | | |`;
      const who = r.aiAssisted ? r.sessions.filter((s) => s.confidence !== 'low').map((s) => `${s.agent}/${s.models[0] ?? '?'}`).join(', ') : 'human';
      const lines = `${r.totals.unknownLines ? '?' : r.totals.aiLinesAdded} / ${r.totals.totalLinesAdded}`;
      const t = { passed: '✅', failed: '❌', unknown: '❔', none: '—' }[r.testsRun.status];
      const cost = r.aiAssisted && r.estimatedCostUsd.amount !== null ? usd(r.estimatedCostUsd.amount) : '—';
      return `| ${short} | ${subj} | ${mdEscape(who)}${r.confidence && r.aiAssisted ? ` (${r.confidence})` : ''} | ${lines} | ${t} | ${cost} |`;
    })
    .join('\n');

  const body = [
    COMMENT_MARKER,
    `**${headline}**`,
    '',
    '<details><summary>Per-commit receipts</summary>',
    '',
    '| Commit | Subject | Author | AI / added lines | Tests | Est. cost |',
    '|---|---|---|---|---|---|',
    table,
    '',
    'Commits without a receipt are not assumed to be human-written. Line shares exclude lines an agent may have written through shell commands. Costs are estimates at public list prices. See `rcpt receipt <sha>` for details.',
    '</details>',
  ].join('\n');

  return { headline, body, stats: { commits: rows.length, withReceipt: withReceipt.length, aiAssisted: ai.length, aiShare, costUsd, tests } };
}

/** Markdown for a README badge using a static shields.io URL (only the label and percentage leave your machine). */
export function badgeMarkdown(aiShare: number | null, label = 'AI-written lines'): string {
  const enc = (s: string) => encodeURIComponent(s.replace(/-/g, '--').replace(/_/g, '__'));
  const value = aiShare === null ? 'n/a' : `${Math.round(aiShare * 100)}%`;
  return `![${label}: ${value}](https://img.shields.io/badge/${enc(label)}-${enc(value)}-2a78d6)`;
}

import type { Confidence, Receipt } from './types.js';

const useColor = () => process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) => (useColor() ? `\x1b[${code}m${s}\x1b[0m` : s);
export const c = { bold: paint('1'), dim: paint('2'), green: paint('32'), yellow: paint('33'), red: paint('31'), cyan: paint('36') };

const conf = (x: Confidence | null) => (x === 'high' ? c.green(x) : x === 'medium' ? c.yellow(x) : x === 'low' ? c.red(x) : c.dim('n/a'));
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—');
export const usd = (n: number | null) => (n === null ? 'unknown' : n < 0.01 && n > 0 ? '<$0.01' : `$${n.toFixed(2)}`);

export function formatReceipt(r: Receipt, subject?: string): string {
  const out: string[] = [];
  out.push(`${c.bold('🧾 rcpt receipt')}  ${c.cyan(r.commitSha.slice(0, 10))}${subject ? `  ${subject}` : ''}`);
  if (r.isMerge) return [...out, c.dim('Merge commit: not attributed (its lines come from the merged commits).')].join('\n');

  out.push(`AI-assisted   ${r.aiAssisted ? c.bold('yes') : 'no'}${r.confidence ? `  (link confidence: ${conf(r.confidence)})` : '  (no agent session found in this commit window)'}`);
  for (const s of r.sessions) {
    out.push(`  ${s.agent}${s.agentVersion ? ` ${s.agentVersion}` : ''} · ${s.models.join(', ') || 'model unknown'} · ${conf(s.confidence)} ${c.dim(`(${s.evidence.join(', ')})`)}`);
  }
  if (r.promptSummary) out.push(`Prompt        ${c.dim('“')}${r.promptSummary}${c.dim('”')}`);

  if (r.filesAttributed.length) {
    out.push('', c.bold('Files                                  AI lines / added   confidence'));
    for (const f of r.filesAttributed) {
      const ai = f.aiLinesAdded === null ? '?' : f.unknownLines ? `${f.aiLinesAdded}+?` : String(f.aiLinesAdded);
      out.push(`  ${f.path.length > 36 ? '…' + f.path.slice(-35) : f.path.padEnd(36)} ${`${ai} / ${f.totalLinesAdded}`.padStart(16)}   ${conf(f.confidence)}`);
    }
    const t = r.totals;
    const known = t.totalLinesAdded - t.unknownLines;
    out.push(
      `  ${'Total'.padEnd(36)} ${`${t.aiLinesAdded} / ${t.totalLinesAdded}`.padStart(16)}   ${pct(t.aiLinesAdded, known)} AI` +
        (t.unknownLines ? c.dim(` of attributable lines; ${t.unknownLines} unknown`) : ''),
    );
  }

  out.push('');
  const tests = r.testsRun;
  const tLabel = tests.status === 'passed' ? c.green('passed') : tests.status === 'failed' ? c.red('failed') : tests.status === 'unknown' ? c.yellow('ran, result unknown') : c.dim('none detected');
  out.push(`Tests         ${tLabel}${tests.command ? c.dim(`  (${tests.command})`) : ''}`);
  const cost = r.estimatedCostUsd;
  if (!r.aiAssisted) out.push(`Est. cost     ${c.dim('n/a (no AI session linked)')}`);
  else out.push(
    `Est. cost     ${usd(cost.amount)}  ${c.dim(`(${cost.confidence} confidence, list prices ${cost.pricingVersion}${cost.unpricedModels.length ? `; no price for ${cost.unpricedModels.join(', ')}` : ''})`)}`,
  );
  if (r.humanEditedAfterAi !== null) out.push(`Human edits   ${r.humanEditedAfterAi ? 'yes, AI-touched files also contain non-AI lines' : 'none detected in AI-touched files'}`);
  out.push(c.dim(`schema ${r.schemaVersion} · generated ${r.createdAt} by rcpt ${r.generator.version}`));
  return out.join('\n');
}

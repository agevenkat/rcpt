import type { ReportData } from './data.js';

// One self-contained file: inline CSS, inline SVG, a few lines of inline JS for hover. No external requests.
// Colors follow a validated categorical palette (AI = slot 1 blue, human = slot 2 orange; CVD ΔE ≈ 25 in
// both modes); "unknown" is a recessive hatched gray so it never reads as a third category.

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
const pct = (x: number | null, d = 0) => (x === null ? '—' : `${(x * 100).toFixed(d)}%`);
const usd = (n: number | null) => (n === null ? '—' : n > 0 && n < 0.01 ? '<$0.01' : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const int = (n: number) => n.toLocaleString('en-US');

function tile(label: string, value: string, note: string): string {
  return `<div class="tile"><div class="tile-label">${esc(label)}</div><div class="tile-value">${esc(value)}</div><div class="tile-note">${esc(note)}</div></div>`;
}

/** Weekly stacked columns: AI (bottom), human, unknown (top). 2px surface gaps, 4px rounded data-end. */
function weeklyChart(d: ReportData): string {
  const weeks = d.weekly;
  if (!weeks.length) return '<p class="muted">No commits in this period.</p>';
  const W = 720, H = 240, padL = 48, padB = 28, padT = 12;
  const max = Math.max(1, ...weeks.map((w) => w.ai + w.human + w.unknown));
  const nice = (() => {
    const p = 10 ** Math.floor(Math.log10(max));
    return [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map((m) => m * p).find((v) => v >= max)!;
  })();
  const plotW = W - padL - 8, plotH = H - padT - padB;
  const band = plotW / weeks.length;
  const bw = Math.min(24, band * 0.6);
  const y = (v: number) => padT + plotH - (v / nice) * plotH;
  const grid = [0, 0.5, 1]
    .map((f) => `<line x1="${padL}" x2="${W - 8}" y1="${y(nice * f)}" y2="${y(nice * f)}" class="${f === 0 ? 'axis' : 'grid'}"/><text x="${padL - 6}" y="${y(nice * f) + 4}" class="tick" text-anchor="end">${int(nice * f)}</text>`)
    .join('');
  const GAP = 2;
  const bars = weeks
    .map((w, i) => {
      const x = padL + band * i + (band - bw) / 2;
      const segs = [
        { v: w.ai, fill: 'var(--series-1)' },
        { v: w.human, fill: 'var(--series-2)' },
        { v: w.unknown, fill: 'url(#hatch)' },
      ].filter((s) => s.v > 0);
      let acc = 0;
      const parts = segs
        .map((s, k) => {
          const y0 = y(acc), y1 = y(acc + s.v);
          acc += s.v;
          const top = y1 + (k > 0 ? 0 : 0);
          const bottom = y0 - (k > 0 ? GAP : 0);
          const h = Math.max(0, bottom - top);
          if (h <= 0) return '';
          const last = k === segs.length - 1;
          const r = last ? Math.min(4, h, bw / 2) : 0;
          // Rounded top only on the data end; square at the baseline and between segments.
          return `<path d="M${x},${bottom} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${bottom} Z" fill="${s.fill}"/>`;
        })
        .join('');
      const label = i % Math.ceil(weeks.length / 8) === 0 ? `<text x="${x + bw / 2}" y="${H - 8}" class="tick" text-anchor="middle">${w.week.slice(5)}</text>` : '';
      const tip = `Week of ${w.week}|AI ${int(w.ai)}|Human ${int(w.human)}|Unknown ${int(w.unknown)}|${w.commits} commits, ${w.aiCommits} AI-assisted${w.noReceipt ? `, ${w.noReceipt} without receipt` : ''}`;
      return `<g class="hit" tabindex="0" data-tip="${esc(tip)}"><rect x="${padL + band * i}" y="${padT}" width="${band}" height="${plotH}" fill="transparent"/>${parts}</g>${label}`;
    })
    .join('');
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Added lines per week by author: AI, human, unknown">
<defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="var(--unknown-bg)"/><line x1="0" y1="0" x2="0" y2="6" stroke="var(--unknown-ink)" stroke-width="2"/></pattern></defs>
${grid}${bars}</svg>`;
}

function legend(): string {
  return `<div class="legend"><span><i style="background:var(--series-1)"></i>AI-written</span><span><i style="background:var(--series-2)"></i>Human-written</span><span><i class="hatch"></i>Unknown (agent wrote via shell; no line-level log)</span></div>`;
}

export function renderHtml(d: ReportData): string {
  const known = d.lines.ai + d.lines.human;
  const rw = d.rewrite;
  const tiles = [
    tile('AI share of added lines', pct(d.lines.aiShare), `${int(d.lines.ai)} of ${int(known)} attributable lines` + (d.lines.unknown ? ` · ${int(d.lines.unknown)} unknown` : '')),
    tile('AI-assisted commits', `${int(d.commits.aiAssisted)} / ${int(d.commits.withReceipt)}`, `${int(d.commits.withoutReceipt)} commits have no receipt`),
    tile('Estimated spend', usd(d.spend.total), d.spend.aiCommitsWithUnknownCost ? `${d.spend.aiCommitsWithUnknownCost} AI commits had no usage data` : 'at list prices'),
    tile('Cost per AI commit', usd(d.spend.perAiCommit), 'commits with known cost'),
    tile('Tests passed', pct(d.tests.passRate), `of AI-assisted commits · ${d.tests.withTests} ran tests`),
    tile(
      `AI lines rewritten ≤${rw.days}d`,
      pct(rw.ai.rate),
      rw.ai.rate === null ? `needs commits ≥${rw.days} days old` : rw.human.rate === null ? 'no human baseline yet' : `human lines: ${pct(rw.human.rate)}`,
    ),
  ].join('');

  const agentRows = d.agents.length
    ? d.agents
        .map(
          (a) =>
            `<tr><td>${esc(a.agent)}</td><td>${esc(a.models.join(', ') || '—')}</td><td class="n">${int(a.commits)}</td><td class="n">${int(a.aiLines)}</td><td class="n">${usd(a.spend)}${a.unknownSpendCommits ? `<sup title="${a.unknownSpendCommits} commits without usage data">†</sup>` : ''}</td><td class="n">${usd(a.costPerCommit)}</td></tr>`,
        )
        .join('')
    : '<tr><td colspan="6" class="muted">No AI-assisted commits in this period.</td></tr>';

  const weeklyRows = d.weekly
    .map((w) => `<tr><td>${w.week}</td><td class="n">${int(w.ai)}</td><td class="n">${int(w.human)}</td><td class="n">${int(w.unknown)}</td><td class="n">${w.commits}</td><td class="n">${w.aiCommits}</td><td class="n">${w.noReceipt}</td></tr>`)
    .join('');

  const commitRows = d.rows
    .slice(0, 100)
    .map((r) => {
      const rc = r.receipt;
      const status = !rc ? '<span class="muted">no receipt</span>' : rc.aiAssisted ? `AI · ${esc(rc.confidence ?? '')}` : 'human';
      const lines = rc ? `${rc.totals.unknownLines ? '?' : int(rc.totals.aiLinesAdded)} / ${int(rc.totals.totalLinesAdded)}` : '—';
      const agents = rc ? esc([...new Set(rc.sessions.filter((s) => s.confidence !== 'low').map((s) => s.agent))].join(', ')) : '';
      const tests = rc ? rc.testsRun.status.replace('none', '—') : '—';
      const cost = rc && rc.aiAssisted ? usd(rc.estimatedCostUsd.amount) : '—';
      return `<tr><td><code>${r.sha.slice(0, 8)}</code></td><td>${r.date.slice(0, 10)}</td><td class="subj">${esc(r.subject)}</td><td>${status}</td><td>${agents}</td><td class="n">${lines}</td><td>${tests}</td><td class="n">${cost}</td></tr>`;
    })
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>rcpt report · ${esc(d.repo)}</title>
<style>
:root{color-scheme:light;--page:#f9f9f7;--surface:#fcfcfb;--ink:#0b0b0b;--ink-2:#52514e;--muted:#898781;--grid:#e1e0d9;--axis:#c3c2b7;--border:rgba(11,11,11,.10);
--series-1:#2a78d6;--series-2:#eb6834;--series-3:#1baf7a;--series-4:#eda100;--series-5:#e87ba4;--unknown-bg:#e1e0d9;--unknown-ink:#a9a8a1}
@media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])){color-scheme:dark;--page:#0d0d0d;--surface:#1a1a19;--ink:#f0efec;--ink-2:#c3c2b7;--grid:#2c2c2a;--axis:#383835;--border:rgba(255,255,255,.10);
--series-1:#3987e5;--series-2:#d95926;--series-3:#199e70;--series-4:#c98500;--series-5:#d55181;--unknown-bg:#2c2c2a;--unknown-ink:#5a5955}}
:root[data-theme="dark"]{color-scheme:dark;--page:#0d0d0d;--surface:#1a1a19;--ink:#f0efec;--ink-2:#c3c2b7;--grid:#2c2c2a;--axis:#383835;--border:rgba(255,255,255,.10);
--series-1:#3987e5;--series-2:#d95926;--series-3:#199e70;--series-4:#c98500;--series-5:#d55181;--unknown-bg:#2c2c2a;--unknown-ink:#5a5955}
*{box-sizing:border-box}body{margin:0;background:var(--page);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:1040px;margin:0 auto;padding:32px 16px 64px}h1{font-size:24px;margin:0 0 4px}h2{font-size:17px;margin:40px 0 12px}
.sub,.muted,.tile-note,.tick{color:var(--ink-2)}.muted{color:var(--muted)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-top:24px}
.tile,.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px 16px}
.tile-label{font-size:13px;color:var(--ink-2)}.tile-value{font-size:28px;font-weight:600;font-variant-numeric:tabular-nums;margin:2px 0}.tile-note{font-size:12px}
svg{width:100%;height:auto;display:block}.grid{stroke:var(--grid);stroke-width:1}.axis{stroke:var(--axis);stroke-width:1}.tick{font-size:11px;fill:var(--muted)}
.hit:focus{outline:none}.hit:focus rect,.hit:hover rect{fill:var(--grid);fill-opacity:.5}
.legend{display:flex;flex-wrap:wrap;gap:16px;font-size:13px;color:var(--ink-2);margin-bottom:8px}.legend i,.sw{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px}
.hatch{background:repeating-linear-gradient(45deg,var(--unknown-ink) 0 2px,var(--unknown-bg) 2px 5px)}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--grid);vertical-align:top}th{color:var(--ink-2);font-weight:500}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}td.subj{max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}code{font-size:12px}
.scroll{overflow-x:auto}details{margin-top:8px}summary{cursor:pointer;color:var(--ink-2);font-size:13px}
#tip{position:fixed;pointer-events:none;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:8px 10px;font-size:12px;box-shadow:0 4px 16px rgba(0,0,0,.12);display:none;white-space:nowrap}
#tip b{display:block;margin-bottom:2px}.how li{margin:6px 0}.conf{font-variant-numeric:tabular-nums}
</style>
</head>
<body>
<main>
<h1>🧾 rcpt report · ${esc(d.repo)}</h1>
<div class="sub">${esc(d.since.slice(0, 10))} → ${esc(d.generatedAt.slice(0, 10))} · ${int(d.commits.total)} commits (${int(d.commits.merges)} merges excluded) · generated by rcpt ${esc(d.rcptVersion)}</div>

<div class="tiles">${tiles}</div>

<h2>Added lines per week</h2>
<div class="card">${legend()}${weeklyChart(d)}
<details><summary>Table view</summary><div class="scroll"><table><thead><tr><th>Week of</th><th class="n">AI lines</th><th class="n">Human lines</th><th class="n">Unknown</th><th class="n">Commits</th><th class="n">AI-assisted</th><th class="n">No receipt</th></tr></thead><tbody>${weeklyRows}</tbody></table></div></details>
</div>

<h2>By agent</h2>
<div class="card scroll"><table><thead><tr><th>Agent</th><th>Models</th><th class="n">AI commits</th><th class="n">AI lines</th><th class="n">Est. spend</th><th class="n">Cost / commit</th></tr></thead><tbody>${agentRows}</tbody></table>
${d.spend.unpricedModels.length ? `<p class="muted">No price for: ${esc(d.spend.unpricedModels.join(', '))}. Their usage is excluded from spend; add prices under "pricing" in .rcpt.json.</p>` : ''}
${d.agents.some((a) => a.unknownSpendCommits) ? '<p class="muted">† some commits had no token usage in the agent log; their cost is unknown, not zero.</p>' : ''}</div>

<h2>Quality signals</h2>
<div class="card"><table><tbody>
<tr><td>AI-assisted commits where tests ran</td><td class="n">${int(d.tests.withTests)} / ${int(d.tests.aiCommits)}</td></tr>
<tr><td>…and the last test run passed</td><td class="n">${int(d.tests.passed)} (${pct(d.tests.passRate)})</td></tr>
<tr><td>…last test run failed / result unknown</td><td class="n">${int(d.tests.failed)} / ${int(d.tests.unknown)}</td></tr>
<tr><td>AI lines changed or deleted within ${rw.days} days</td><td class="n">${int(rw.ai.rewritten)} / ${int(rw.ai.lines)} (${pct(rw.ai.rate, 1)})</td></tr>
<tr><td>Human lines changed or deleted within ${rw.days} days</td><td class="n">${int(rw.human.rewritten)} / ${int(rw.human.lines)} (${pct(rw.human.rate, 1)})</td></tr>
<tr><td class="muted" colspan="2">Rewrite rates measured on ${int(rw.commitsMeasured)} commits at least ${rw.days} days old${rw.commitsTooRecent ? `; ${int(rw.commitsTooRecent)} newer commits not yet measurable` : ''}${rw.capped ? '; capped at the most recent eligible commits' : ''}.</td></tr>
</tbody></table></div>

<h2>Commits</h2>
<div class="card scroll"><table><thead><tr><th>Commit</th><th>Date</th><th>Subject</th><th>Author</th><th>Agents</th><th class="n">AI / added</th><th>Tests</th><th class="n">Est. cost</th></tr></thead><tbody>${commitRows}</tbody></table>
${d.rows.length > 100 ? `<p class="muted">Showing the latest 100 of ${int(d.rows.length)} commits. Use <code>rcpt report --json</code> for all.</p>` : ''}</div>

<h2>How these numbers are computed</h2>
<div class="card how"><ul>
<li><b>Source.</b> Each commit's receipt (a git note under <code>refs/notes/rcpt</code>) was computed from coding-agent session logs on the committer's machine. Commits without a receipt (${int(d.commits.withoutReceipt)}) are shown as “no receipt” and excluded from line counts. They are never assumed to be human-written.</li>
<li><b>Linking a session to a commit.</b> A session counts when it ran in this repository between the parent commit and this commit. <span class="conf">High</span>: lines the agent wrote appear in the commit (whitespace-normalized line hashes). <span class="conf">Medium</span>: the agent edited a committed file, or ran the <code>git commit</code> itself. <span class="conf">Low</span>: it was only active in the time window, and is not counted as AI-assisted. Links in this period: ${int(d.linkConfidence.high)} high, ${int(d.linkConfidence.medium)} medium, ${int(d.linkConfidence.low)} low.</li>
<li><b>AI share.</b> AI lines ÷ (AI + human lines), counting non-blank added lines. Lines in files an agent may have written through shell commands (which its log doesn't capture line by line) are <i>unknown</i> and left out of the share. They are not counted as human. Generated files (lockfiles, build output, and anything under <code>ignore</code> in .rcpt.json) are excluded entirely: ${int(d.lines.ignored)} lines in this period.</li>
<li><b>Spend.</b> Token usage from the agent logs inside each commit window, priced at public list prices (pricing table ${esc(d.pricingVersions.join(', ') || 'n/a')}). Subscription plans aren't billed per token, so treat this as the API-equivalent cost. A commit whose session logged no usage has unknown cost, never $0. Lowest cost confidence in this period: ${esc(d.spend.lowestConfidence ?? 'n/a')}.</li>
<li><b>Tests.</b> The last test-runner command (npm test, pytest, go test, cargo test, …) that a linked session ran in this repository during the commit window, and its exit code.</li>
<li><b>Rewrite rate.</b> For commits at least ${rw.days} days old, <code>git blame --reverse -w</code> follows each added line to the last first-parent commit within ${rw.days} days. Lines that don't survive count as rewritten. The human rate uses the same method as a baseline.</li>
<li><b>Known limits.</b> If you split one agent session's work across several commits, edits made before the previous commit count toward that commit only. Agents prune old logs (Claude Code keeps about 30 days by default), so backfilled receipts for older commits may find no session.</li>
</ul></div>
</main>
<div id="tip" role="status"></div>
<script>
(function(){var t=document.getElementById('tip');function show(e){var g=e.target.closest&&e.target.closest('[data-tip]');if(!g){t.style.display='none';return}var p=g.getAttribute('data-tip').split('|');t.textContent='';var b=document.createElement('b');b.textContent=p[0];t.appendChild(b);for(var i=1;i<p.length;i++){var d=document.createElement('div');d.textContent=p[i];t.appendChild(d)}t.style.display='block';var r=g.getBoundingClientRect(),x=(e.clientX||r.left+r.width/2)+12,y=(e.clientY||r.top)+12;if(x+t.offsetWidth>innerWidth-8)x=innerWidth-t.offsetWidth-8;t.style.left=x+'px';t.style.top=y+'px'}
document.addEventListener('pointermove',show);document.addEventListener('focusin',show);document.addEventListener('pointerleave',function(){t.style.display='none'})})();
</script>
</body>
</html>
`;
}

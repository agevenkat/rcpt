import fs from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { Command } from 'commander';
import { createAdapters } from './adapters/index.js';
import { formatDoctor, runDoctor } from './doctor.js';
import { sinceDate } from './util/duration.js';
import { VERSION } from './version.js';
import { attributeCommit } from './attribute.js';
import { loadConfig } from './config.js';
import { loadPricing } from './cost.js';
import { git, repoRoot } from './git.js';
import { init, readRecord, syncConfigChanges, uninstall } from './install.js';
import { NOTES_REF, readReceipt, syncNotes } from './notes.js';
import { backfill, commitMsg, postCommit, prePush } from './hook.js';
import { c, formatReceipt } from './format.js';
import { buildReport } from './report/data.js';
import { renderHtml } from './report/html.js';
import { badgeMarkdown } from './pr-summary.js';

const program = new Command();
program.name('rcpt').description('rcpt: receipts for AI-written code.').version(VERSION);

function root(): string {
  try {
    return repoRoot(process.cwd());
  } catch {
    throw new Error('not inside a git repository');
  }
}

program
  .command('init')
  .description('Install rcpt in this repository (post-commit hook, .rcpt.json, optional receipt sharing)')
  .option('-y, --yes', 'also set up receipt sharing with your remote without asking')
  .option('--no-sync', 'skip receipt sharing (no git config changes, no pre-push hook)')
  .action(async (opts: { yes?: boolean; sync: boolean }) => {
    const r = root();
    const changes = syncConfigChanges(r);
    let sync = opts.sync !== false && !!opts.yes;
    if (opts.sync !== false && !opts.yes && !readRecord(r)?.config.length) {
      console.log(
        [
          c.bold('Share receipts with your team?'),
          `rcpt stores each receipt as a git note under ${NOTES_REF}. Notes stay local unless git is told to`,
          'fetch and push them. With your permission rcpt will:',
          ...changes.map((ch) => `  • git config --add ${ch.key} ${ch.value}`),
          '  • add a pre-push hook that pushes refs/notes/rcpt in the background after merging teammates\' notes',
          c.dim('It never changes what a plain `git push` pushes. `rcpt uninstall` reverts all of it.'),
        ].join('\n'),
      );
      if (process.stdin.isTTY) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        sync = /^\s*(y|yes)?\s*$/i.test(await rl.question('Set this up? [Y/n] '));
        rl.close();
      } else {
        console.log(c.dim('Not a terminal: skipping. Re-run `rcpt init --yes` to enable sharing.'));
      }
    }
    const cli = { node: process.execPath, script: fs.realpathSync(process.argv[1]!) };
    const log = init(r, { cli, sync, trailer: loadConfig(r).trailer });
    console.log(['', c.bold('rcpt installed'), ...log.map((l) => `  ✓ ${l}`)].join('\n'));
    const found = (await Promise.all(createAdapters().map(async (a) => ((await a.detect()).detected ? a.displayName : null)))).filter(Boolean);
    console.log(`\nAgents detected: ${found.length ? found.join(', ') : c.yellow('none yet')}`);
    console.log(`Next: make a commit with your agent, then run ${c.bold('rcpt receipt HEAD')}.`);
  });

program
  .command('uninstall')
  .description('Remove rcpt hooks, config and git settings from this repository')
  .option('--purge-notes', `also delete stored receipts (${NOTES_REF})`)
  .action((opts: { purgeNotes?: boolean }) => {
    const r = root();
    const log = uninstall(r);
    if (opts.purgeNotes) {
      for (const ref of git(r, ['for-each-ref', '--format=%(refname)', NOTES_REF, 'refs/notes/remotes/']).split('\n').filter((x) => x.endsWith('rcpt'))) {
        git(r, ['update-ref', '-d', ref]);
        log.push(`deleted ${ref}`);
      }
    } else log.push(`receipts kept in ${NOTES_REF} (use --purge-notes to delete them)`);
    console.log(log.map((l) => `  ✓ ${l}`).join('\n'));
  });

program
  .command('receipt')
  .description('Show the receipt for a commit')
  .argument('[rev]', 'commit', 'HEAD')
  .option('--json', 'print the raw receipt JSON')
  .action((rev: string, opts: { json?: boolean }) => {
    const r = root();
    const sha = git(r, ['rev-parse', '--verify', `${rev}^{commit}`]).trim();
    const receipt = readReceipt(r, sha);
    if (!receipt) {
      console.error(`No receipt for ${sha.slice(0, 10)}. A missing receipt doesn't mean the commit is human-written.`);
      console.error(`Run ${c.bold(`rcpt attribute ${rev}`)} to compute one, or ${c.bold('rcpt backfill')} for past commits.`);
      process.exitCode = 1;
      return;
    }
    const subject = git(r, ['show', '-s', '--format=%s', sha]).trim();
    console.log(opts.json ? JSON.stringify(receipt, null, 2) : formatReceipt(receipt, subject));
  });

program
  .command('backfill')
  .description('Generate receipts for past commits from agent logs still on this machine')
  .option('--since <duration>', 'how far back', '30d')
  .option('--force', 'recompute commits that already have a receipt')
  .option('--dry-run', 'compute but do not write notes')
  .action(async (opts: { since: string; force?: boolean; dryRun?: boolean }) => {
    const tty = process.stderr.isTTY;
    const res = await backfill(process.cwd(), sinceDate(opts.since), {
      force: opts.force,
      dryRun: opts.dryRun,
      onProgress: (d, t) => tty && process.stderr.write(`\r  attributing ${d}/${t} commits…`),
    });
    if (tty) process.stderr.write('\n');
    console.log(
      `${res.considered} commits in the last ${opts.since}: ${res.written} receipts ${opts.dryRun ? 'computed (dry run)' : 'written'}, ` +
        `${res.aiAssisted} AI-assisted, ${res.skippedExisting} already had receipts${res.failed ? `, ${c.red(`${res.failed} failed (see ~/.rcpt/logs)`)}` : ''}.`,
    );
    console.log(c.dim('Agents prune old logs (Claude Code keeps ~30 days by default), so older commits may show no session.'));
  });

program
  .command('report')
  .description('Write a self-contained HTML report of AI share, spend, tests and rewrite rate (or --json)')
  .option('--since <duration>', 'period to cover', '30d')
  .option('--out <file>', 'HTML output path', 'rcpt-report.html')
  .option('--json', 'print the report data as JSON instead')
  .option('--rewrite-days <n>', 'count AI lines changed within this many days as rewritten', '14')
  .action((opts: { since: string; out: string; json?: boolean; rewriteDays: string }) => {
    const data = buildReport(root(), { since: sinceDate(opts.since), rewriteDays: Number(opts.rewriteDays) || 14, maxRewriteCommits: 300 });
    if (opts.json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    fs.writeFileSync(opts.out, renderHtml(data));
    console.log(`  ✓ wrote ${opts.out}  (${data.commits.aiAssisted} AI-assisted of ${data.commits.withReceipt} commits with receipts, ${data.commits.withoutReceipt} without)`);
  });

program
  .command('badge')
  .description('Print a README badge (markdown) with the AI share of added lines')
  .option('--since <duration>', 'period to cover', '90d')
  .option('--label <text>', 'badge label', 'AI-written lines')
  .action((opts: { since: string; label: string }) => {
    const data = buildReport(root(), { since: sinceDate(opts.since), rewriteDays: 14, maxRewriteCommits: 0 });
    console.log(badgeMarkdown(data.lines.aiShare, opts.label));
  });

program
  .command('attribute')
  .description('Compute the receipt for a commit without writing it (prints JSON)')
  .argument('[rev]', 'commit to attribute', 'HEAD')
  .action(async (rev: string) => {
    const r = root();
    const config = loadConfig(r);
    const receipt = await attributeCommit({ repoDir: r, rev, adapters: createAdapters(), config, pricing: loadPricing(config.pricing) });
    console.log(JSON.stringify(receipt, null, 2));
  });

program
  .command('sync')
  .description(`Fetch teammates' receipts and push yours (${NOTES_REF})`)
  .argument('[remote]', 'remote name', 'origin')
  .action((remote: string) => {
    syncNotes(root(), remote);
    console.log(`  ✓ receipts synced with ${remote}`);
  });

program
  .command('doctor')
  .description('Show which coding agents were detected, how many sessions were found, and any parse warnings')
  .option('--since <duration>', 'only parse sessions modified within this window', '30d')
  .option('--json', 'machine-readable output')
  .option('-v, --verbose', 'show all warnings and ignored event types')
  .action(async (opts: { since: string; json?: boolean; verbose?: boolean }) => {
    const reports = await runDoctor(createAdapters(), sinceDate(opts.since));
    console.log(opts.json ? JSON.stringify(reports, null, 2) : formatDoctor(reports, opts.since, opts.verbose));
  });

// Called by git hooks. Never prints, never fails: errors go to ~/.rcpt/logs/rcpt.log.
program
  .command('hook', { hidden: true })
  .argument('<name>')
  .argument('[arg]')
  .action(async (name: string, arg: string | undefined) => {
    if (name === 'post-commit') await postCommit(process.cwd(), arg);
    else if (name === 'pre-push') await prePush(process.cwd(), arg);
    else if (name === 'commit-msg') await commitMsg(process.cwd(), arg);
  });

program.parseAsync().catch((err: unknown) => {
  const e = err as { stderr?: unknown; message?: string };
  const detail = typeof e.stderr === 'string' && e.stderr.trim() ? e.stderr.trim().split('\n').at(-1) : e.message;
  console.error(`rcpt: ${detail ?? String(err)}`);
  process.exitCode = 1;
});

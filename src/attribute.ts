import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { AgentAdapter, ParseResult } from './adapters/types.js';
import type { AgentSession, Confidence, Evidence, FileAttribution, Receipt, TestStatus } from './types.js';
import { RECEIPT_SCHEMA_VERSION } from './types.js';
import { commitAddedLines, commitMeta, git, parseDiffAdded, repoRoot, worktreeRoots, type AddedLine } from './git.js';
import { canonical, isUnder, normPath, relTo } from './paths.js';
import { hashLine } from './util/lines.js';
import { isTestCommand } from './util/test-commands.js';
import { compilePatterns, DEFAULT_IGNORE, globToRegExp, type RcptConfig } from './config.js';
import { costOf, type PricingTable } from './cost.js';
import { VERSION } from './version.js';

export interface AttributeOptions {
  repoDir: string;
  rev?: string;
  adapters: AgentAdapter[];
  config: RcptConfig;
  pricing: PricingTable;
  /** Reuse parsed sessions across commits (backfill). Keyed by path + mtime. */
  cache?: Map<string, ParseResult>;
  now?: Date;
}

const RANK: Record<Confidence, number> = { low: 1, medium: 2, high: 3 };
const strongest = (cs: Confidence[]): Confidence | null =>
  cs.length ? cs.reduce((a, b) => (RANK[b] > RANK[a] ? b : a)) : null;

export interface CommitWindow {
  start: number;
  end: number;
}

function repoRoots(repoDir: string): { root: string; roots: string[]; raw: string[] } {
  const rawRoot = repoRoot(repoDir);
  const root = normPath(rawRoot);
  const raw = [rawRoot, ...worktreeRoots(rawRoot)];
  return { root, roots: [...new Set([root, ...raw.map((r) => normPath(r))])], raw };
}

/**
 * Gemini CLI keys sessions by sha256(project root) as the OS spells it. Hash every plausible spelling:
 * git's (C:/x on Windows), native separators (C:\x), and our canonical form.
 */
function projectHashes(raw: string[], roots: string[]): Set<string> {
  const variants = new Set<string>();
  for (const p of [...raw, ...roots]) {
    variants.add(p);
    variants.add(p.replace(/\//g, '\\'));
    variants.add(path.resolve(p));
  }
  return new Set([...variants].map((v) => createHash('sha256').update(v).digest('hex')));
}

/** Lower bound of a commit window: the parent commit. Author time survives rebases, so take the earlier. */
function parentTimeOf(root: string, parent: string | undefined, commitTime: number, config: RcptConfig): number {
  if (!parent) return commitTime - config.rootLookbackDays * 86_400_000;
  const p = commitMeta(root, parent);
  return Math.min(p.authorTime, p.committerTime);
}

export async function attributeCommit(o: AttributeOptions): Promise<Receipt> {
  const { root, roots, raw } = repoRoots(o.repoDir);
  const meta = commitMeta(root, o.rev ?? 'HEAD');
  const base = emptyReceipt(meta.sha, o.pricing.version, o.now);
  if (meta.parents.length > 1) return { ...base, isMerge: true };
  let parentTime = parentTimeOf(root, meta.parents[0], meta.committerTime, o.config);
  // Rebased or cherry-picked onto a parent that is newer than this commit's own authorship: the work predates
  // the parent, so bound the window by the author time instead (with the same lookback as a first commit).
  if (parentTime > meta.authorTime) parentTime = meta.authorTime - o.config.rootLookbackDays * 86_400_000;
  return attributeCore(o, base, roots, raw, parentTime, meta.committerTime, commitAddedLines(root, meta.sha));
}

/** Attribute the staged changes of a commit that doesn't exist yet (used for the opt-in commit trailer). */
export async function attributeStaged(o: AttributeOptions): Promise<Receipt> {
  const { root, roots, raw } = repoRoots(o.repoDir);
  const now = (o.now ?? new Date()).getTime();
  let head: string | undefined;
  try {
    head = git(root, ['rev-parse', '--verify', '-q', 'HEAD']).trim();
  } catch {
    head = undefined; // first commit
  }
  const diff = parseDiffAdded(git(root, ['diff', '--cached', '-M', '-U0', '--no-color', '--no-ext-diff', '--no-prefix']));
  return attributeCore(o, emptyReceipt('', o.pricing.version, o.now), roots, raw, parentTimeOf(root, head, now, o.config), now, diff);
}

async function attributeCore(
  o: AttributeOptions,
  base: Receipt,
  roots: string[],
  raw: string[],
  parentTime: number,
  commitTime: number,
  diff: Map<string, AddedLine[]>,
): Promise<Receipt> {
  const grace = o.config.graceMinutes * 60_000;
  // Work before the parent commit belongs to the parent, so grace only extends the end (commit times
  // have 1-second resolution and agents may flush logs slightly late). 1s covers truncation at the start.
  const win: CommitWindow = { start: parentTime - 1000, end: commitTime + grace };
  const inWin = (ts: string) => {
    const t = Date.parse(ts);
    return t >= win.start && t <= win.end;
  };

  // 1. Candidate sessions: same repo, activity overlapping the window.
  const sessions = await candidateSessions(o, roots, projectHashes(raw, roots), win);

  // 2. AI-written line hashes per repo-relative file, tagged with the session that wrote them.
  const aiLines = new Map<string, Map<string, number[]>>(); // file -> hash -> session indexes (stack)
  const touched = sessions.map(() => new Set<string>());
  // normPath case-folds on Windows; map back to the spelling git uses so lookups into the diff work.
  const diffSpelling = new Map([...diff.keys()].map((k) => [canonical(k), k]));
  sessions.forEach((s, i) => {
    for (const e of s.fileEdits) {
      if (!inWin(e.timestamp)) continue;
      const p = normPath(e.path);
      const r = roots.find((x) => isUnder(p, x));
      if (!r) continue;
      const relFolded = relTo(r, p);
      const rel = diffSpelling.get(canonical(relFolded)) ?? relFolded;
      touched[i]!.add(rel);
      const byHash = aiLines.get(rel) ?? new Map<string, number[]>();
      aiLines.set(rel, byHash);
      for (const h of e.addedLineHashes) byHash.set(h, [...(byHash.get(h) ?? []), i]);
    }
  });

  // 3. Line match against the commit diff. Each AI line can be claimed once (multiset).
  const matchedBySession = sessions.map(() => 0);
  const touchedInCommit = sessions.map((_, i) => [...touched[i]!].some((f) => diff.has(f)));
  const sessionConf: Confidence[] = sessions.map((): Confidence => 'low');
  const files: { path: string; ai: number; total: number; touched: boolean; aiLineNos: number[] }[] = [];
  const ignore = [...DEFAULT_IGNORE, ...o.config.ignore].map(globToRegExp);
  let ignoredLines = 0;
  for (const [file, added] of diff) {
    if (ignore.some((re) => re.test(file))) {
      ignoredLines += added.filter((l) => hashLine(l.text)).length;
      continue;
    }
    const byHash = aiLines.get(file);
    let total = 0;
    const aiLineNos: number[] = [];
    for (const line of added) {
      const h = hashLine(line.text);
      if (!h) continue;
      total++;
      const stack = byHash?.get(h);
      if (stack?.length) {
        matchedBySession[stack.pop()!]!++;
        aiLineNos.push(line.n);
      }
    }
    if (total > 0 || byHash) files.push({ path: file, ai: aiLineNos.length, total, touched: !!byHash, aiLineNos });
  }
  // Shell-side signals: commands in this repo during the window.
  const inRepoCmd = (c: { command: string; cwd: string | null }) => {
    const d = effectiveCwd(c.command, c.cwd);
    return !d || roots.some((r) => isUnder(normPath(d), r));
  };
  const repoCmds = sessions.map((s) => s.commandsRun.filter((c) => inWin(c.timestamp) && inRepoCmd(c)));
  const ranCommit = repoCmds.map((cmds) =>
    cmds.some((c) => isGitCommit(c.command) && Date.parse(c.timestamp) >= commitTime - 1000),
  );
  const shellWrites = repoCmds.some((cmds) => cmds.some((c) => mayWriteFiles(c.command)));
  const evidence: Evidence[][] = sessions.map((_, i) => {
    const e: Evidence[] = [];
    if (matchedBySession[i]! > 0) e.push('line-match');
    if (touchedInCommit[i]) e.push('file-match');
    if (ranCommit[i]) e.push('ran-commit');
    return e.length ? e : ['time-window'];
  });
  sessions.forEach((_, i) => {
    sessionConf[i] = matchedBySession[i]! > 0 ? 'high' : touchedInCommit[i] || ranCommit[i] ? 'medium' : 'low';
  });
  const linked = sessions.filter((_, i) => sessionConf[i] !== 'low');
  const overall = strongest(sessionConf);

  const filesAttributed: FileAttribution[] = files
    .filter((f) => f.total > 0)
    .map((f): FileAttribution => {
      const base = { path: f.path, totalLinesAdded: f.total };
      if (f.touched) {
        const lines = f.ai ? { aiLines: toRanges(f.aiLineNos) } : {};
        // Unmatched lines in a file the agent edited are human-written, unless the agent also ran
        // file-writing shell commands: then they may be the agent's too, and the logs can't tell.
        if (shellWrites && f.total > f.ai) return { ...base, aiLinesAdded: f.ai, unknownLines: f.total - f.ai, confidence: 'medium', ...lines };
        return { ...base, aiLinesAdded: f.ai, confidence: f.ai > 0 ? 'high' : 'medium', ...lines };
      }
      if (!sessions.length) return { ...base, aiLinesAdded: 0, confidence: 'high' };
      // An agent was active but logged no edit to this file. If it also ran file-writing shell commands,
      // its share is unknowable from the logs; otherwise the file is most likely human-written.
      return shellWrites ? { ...base, aiLinesAdded: null, confidence: 'low' } : { ...base, aiLinesAdded: 0, confidence: 'medium' };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  // Only decidable for AI-touched files whose every line is accounted for (no unknown lines).
  const decidable = filesAttributed.filter((f) => files.find((x) => x.path === f.path)?.touched && !f.unknownLines && f.aiLinesAdded !== null);
  const humanEditedAfterAi = decidable.length ? decidable.some((f) => f.totalLinesAdded > (f.aiLinesAdded ?? 0)) : null;

  // 4. Tests run by any candidate session inside the window, in this repo.
  const extra = compilePatterns(o.config.testPatterns);
  const tests = sessions
    .flatMap((s) => s.commandsRun)
    .filter((c) => inWin(c.timestamp) && (c.isTest || isTestCommand(c.command, extra)))
    .filter(inRepoCmd)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const lastTest = tests.at(-1);
  const testStatus: TestStatus = !lastTest ? 'none' : lastTest.exitCode === null ? 'unknown' : lastTest.exitCode === 0 ? 'passed' : 'failed';

  // 5. Cost of linked sessions' usage inside the window, overall and per session.
  const sessionCost = (s: AgentSession) => costOf(s.usageEvents.filter((e) => inWin(e.timestamp)), o.pricing, s.tokenUsage !== null);
  const cost = costOf(
    linked.flatMap((s) => s.usageEvents.filter((e) => inWin(e.timestamp))),
    o.pricing,
    linked.some((s) => s.tokenUsage !== null),
  );

  // 6. Prompts: in-window prompts of linked sessions, or the last one before the window ends.
  const prompts = linked
    .flatMap((s) => {
      const inside = s.prompts.filter((p) => inWin(p.timestamp));
      const before = s.prompts.filter((p) => Date.parse(p.timestamp) <= win.end);
      return inside.length ? inside : before.slice(-1);
    })
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    .map((p) => p.text);

  return {
    ...base,
    aiAssisted: linked.length > 0,
    confidence: overall,
    sessions: sessions
      .map((s, i) => ({
        id: s.id,
        agent: s.agent,
        agentVersion: s.agentVersion,
        models: s.models,
        confidence: sessionConf[i]!,
        evidence: evidence[i]!,
        aiLinesAdded: matchedBySession[i]!,
        estimatedCostUsd: sessionConf[i] === 'low' ? null : sessionCost(s).amount,
      }))
      .sort((a, b) => RANK[b.confidence] - RANK[a.confidence]),
    promptSummary: summarize(prompts),
    ...(o.config.storeFullPrompts && prompts.length ? { prompts } : {}),
    filesAttributed,
    totals: {
      aiLinesAdded: filesAttributed.reduce((n, f) => n + (f.aiLinesAdded ?? 0), 0),
      totalLinesAdded: filesAttributed.reduce((n, f) => n + f.totalLinesAdded, 0),
      unknownLines: filesAttributed.reduce((n, f) => n + (f.aiLinesAdded === null ? f.totalLinesAdded : (f.unknownLines ?? 0)), 0),
      ignoredLines,
    },
    testsRun: { status: testStatus, command: lastTest?.command ?? null },
    estimatedCostUsd: { ...cost, pricingVersion: o.pricing.version },
    humanEditedAfterAi,
  };
}

async function candidateSessions(o: AttributeOptions, roots: string[], hashes: Set<string>, win: CommitWindow): Promise<AgentSession[]> {
  const out: AgentSession[] = [];
  for (const a of o.adapters) {
    // A session active in the window was last written after the window started.
    for (const ref of await a.listSessions(new Date(win.start))) {
      const key = `${ref.path}:${ref.mtime.getTime()}`;
      let res = o.cache?.get(key);
      if (!res) {
        res = await a.parseSession(ref.path);
        o.cache?.set(key, res);
      }
      const s = res.session;
      if (!s || Date.parse(s.endedAt) < win.start || Date.parse(s.startedAt) > win.end) continue;
      const inRepo =
        (s.cwd && roots.some((r) => isUnder(normPath(s.cwd!), r))) ||
        (s.projectHash && hashes.has(s.projectHash)) ||
        s.fileEdits.some((e) => roots.some((r) => isUnder(normPath(e.path), r)));
      if (inRepo) out.push(s);
    }
  }
  return out;
}

/**
 * Directory a shell command actually runs in: agents often prefix `cd <dir> &&`, and git accepts
 * `-C <dir>`. Logs record only the session's directory. Unquoted ~ and relative paths are resolved.
 */
export function effectiveCwd(cmd: string, cwd: string | null, home = os.homedir()): string | null {
  let dir = cwd;
  const resolve = (p: string) => {
    const t = p.replace(/^["']|["']$/g, '').replace(/^~(?=\/|$)/, home);
    return path.isAbsolute(t) ? path.resolve(t) : dir ? path.resolve(dir, t) : null;
  };
  let rest = cmd.trimStart();
  for (;;) {
    const m = /^cd\s+("[^"]+"|'[^']+'|\S+)\s*(&&|;)\s*/.exec(rest);
    if (!m) break;
    dir = resolve(m[1]!);
    rest = rest.slice(m[0].length);
  }
  const gitC = /^(?:\w+=\S*\s+)*git\s+-C\s+("[^"]+"|'[^']+'|\S+)/.exec(rest);
  return gitC ? resolve(gitC[1]!) : dir;
}

/** [3,4,5,9] -> "3-5,9" */
export function toRanges(ns: number[]): string {
  const s = [...ns].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < s.length; ) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j]! + 1) j++;
    out.push(i === j ? `${s[i]}` : `${s[i]}-${s[j]}`);
    i = j + 1;
  }
  return out.join(',');
}

export function fromRanges(r: string): number[] {
  return r.split(',').filter(Boolean).flatMap((part) => {
    const [a, b] = part.split('-').map(Number);
    return b === undefined ? [a!] : Array.from({ length: b - a! + 1 }, (_, k) => a! + k);
  });
}

/** `git commit` (any flags, including via `git -C dir`), excluding dry runs. */
export function isGitCommit(cmd: string): boolean {
  return cmd.split(/&&|\|\||;|\n/).some((seg) => /^\s*(\w+=\S*\s+)*git\b(\s+-[cC]\s+\S+)*\s+commit\b/.test(seg) && !/--dry-run/.test(seg));
}

/**
 * Shell commands that can create or modify files outside the agent's edit tools. Deliberately broad:
 * a false positive only lowers confidence, a false negative would overstate it.
 */
export function mayWriteFiles(cmd: string): boolean {
  return (
    /(^|[^<>&\d])>>?\s*(?!&|\/dev\/null)[^\s|&;]/.test(cmd) ||
    /\b(tee|patch|cp|mv|rsync|install|touch|truncate)\b/.test(cmd) ||
    /\b(sed|perl)\s+(-\w*\s+)*-\w*i/.test(cmd) ||
    /\b(python3?|node|ruby|deno|bun|php)\b(?!\s+(-v|--version)\b)/.test(cmd) ||
    /\b(npx|pnpm\s+(dlx|exec)|yarn\s+dlx)\b/.test(cmd) ||
    /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(format|fix|lint:fix|generate|codegen|build)\b/.test(cmd) ||
    /--(write|fix)\b/.test(cmd) ||
    /\bgit\s+(apply|am|checkout|restore|stash|merge|rebase|cherry-pick|revert|reset|pull)\b/.test(cmd)
  );
}

export function summarize(prompts: string[], max = 140): string | null {
  if (!prompts.length) return null;
  // Drop wrapper tags that agents add around pasted or injected text (e.g. <pasted_content id="…">).
  let s = prompts[0]!.replace(/<\/?[a-z][\w-]*(\s[^<>]*)?>/gi, ' ').replace(/\s+/g, ' ').trim();
  if (s.length > max) s = s.slice(0, max - 1).trimEnd() + '…';
  return prompts.length > 1 ? `${s} (+${prompts.length - 1} more)` : s;
}

function emptyReceipt(sha: string, pricingVersion: string, now = new Date()): Receipt {
  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    commitSha: sha,
    aiAssisted: false,
    confidence: null,
    sessions: [],
    promptSummary: null,
    filesAttributed: [],
    totals: { aiLinesAdded: 0, totalLinesAdded: 0, unknownLines: 0, ignoredLines: 0 },
    testsRun: { status: 'none', command: null },
    estimatedCostUsd: { amount: null, pricingVersion, confidence: 'low', unpricedModels: [] },
    humanEditedAfterAi: null,
    isMerge: false,
    createdAt: now.toISOString(),
    generator: { name: 'rcpt', version: VERSION },
  };
}

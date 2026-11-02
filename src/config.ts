import fs from 'node:fs';
import path from 'node:path';
import { rcptHome } from './paths.js';
import { logError } from './log.js';
import type { ModelPrice } from './cost.js';

export const CONFIG_FILE = '.rcpt.json';

export interface RcptConfig {
  /** Slack after the commit time, for second-resolution commit times and late-flushed agent logs. */
  graceMinutes: number;
  /** How far back to look for a repository's first commit, which has no parent to bound the window. */
  rootLookbackDays: number;
  /** Extra test-runner patterns (regular expression sources) on top of the built-in list. */
  testPatterns: string[];
  /** Store full redacted prompts in receipts. Off by default: receipts keep a short summary only. */
  storeFullPrompts: boolean;
  /** Add an "AI-Assisted:" trailer to commit messages. */
  trailer: boolean;
  /** Per-model price overrides, merged over src/pricing.json. */
  pricing: Record<string, Partial<ModelPrice>>;
  /** Extra path globs to leave out of line counts (on top of lockfiles and build output). */
  ignore: string[];
}

/** Generated files nobody writes by hand: excluded from line counts by default. */
export const DEFAULT_IGNORE = [
  '**/package-lock.json', '**/npm-shrinkwrap.json', '**/pnpm-lock.yaml', '**/yarn.lock', '**/bun.lock', '**/bun.lockb',
  '**/Cargo.lock', '**/go.sum', '**/poetry.lock', '**/uv.lock', '**/Pipfile.lock', '**/Gemfile.lock', '**/composer.lock',
  '**/*.min.js', '**/*.min.css', '**/*.map', '**/dist/**', '**/build/**', '**/.next/**', '**/coverage/**', '**/__snapshots__/**',
];

/** Minimal glob: ** spans directories, * stays within one, ? is one character. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === '*' && glob[i + 1] === '*') {
      re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*';
      i += glob[i + 2] === '/' ? 2 : 1;
    } else if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export const DEFAULT_CONFIG: RcptConfig = {
  graceMinutes: 5,
  rootLookbackDays: 7,
  testPatterns: [],
  storeFullPrompts: false,
  trailer: false,
  pricing: {},
  ignore: [],
};

function readJson(file: string): Partial<RcptConfig> {
  try {
    const v: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Partial<RcptConfig>) : {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') logError(`ignoring unreadable config ${file}`, err);
    return {};
  }
}

/** Defaults < ~/.rcpt/config.json < <repo>/.rcpt.json. Bad values fall back to defaults. */
export function loadConfig(repoRoot: string | null, env: NodeJS.ProcessEnv = process.env): RcptConfig {
  const user = readJson(path.join(rcptHome(env), 'config.json'));
  const repo = repoRoot ? readJson(path.join(repoRoot, CONFIG_FILE)) : {};
  const merged = { ...DEFAULT_CONFIG, ...user, ...repo, pricing: { ...user.pricing, ...repo.pricing } };
  const num = (v: unknown, d: number) => (typeof v === 'number' && v >= 0 ? v : d);
  return {
    graceMinutes: num(merged.graceMinutes, DEFAULT_CONFIG.graceMinutes),
    rootLookbackDays: num(merged.rootLookbackDays, DEFAULT_CONFIG.rootLookbackDays),
    testPatterns: Array.isArray(merged.testPatterns) ? merged.testPatterns.filter((p) => typeof p === 'string') : [],
    storeFullPrompts: merged.storeFullPrompts === true,
    trailer: merged.trailer === true,
    pricing: merged.pricing && typeof merged.pricing === 'object' ? merged.pricing : {},
    ignore: Array.isArray(merged.ignore) ? merged.ignore.filter((p) => typeof p === 'string') : [],
  };
}

export function compilePatterns(sources: string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const s of sources) {
    try {
      out.push(new RegExp(s));
    } catch (err) {
      logError(`ignoring invalid testPatterns entry ${JSON.stringify(s)}`, err);
    }
  }
  return out;
}

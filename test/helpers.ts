// Builders for temporary git repos and synthetic agent session logs (integration tests only).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `rcpt-${prefix}-`));
}

/** git with no user/system config, so the developer's hooks and signing settings can't interfere. */
export function gitIn(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: path.join(os.tmpdir(), 'rcpt-empty-gitconfig'),
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function initRepo(dir: string): void {
  fs.writeFileSync(path.join(os.tmpdir(), 'rcpt-empty-gitconfig'), '');
  gitIn(dir, ['init', '-q', '-b', 'main']);
}

export function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** git args that disable every hook (--no-verify does not skip post-commit). */
export function noHooks(): string[] {
  const dir = path.join(os.tmpdir(), 'rcpt-no-hooks');
  fs.mkdirSync(dir, { recursive: true });
  return ['-c', `core.hooksPath=${dir}`];
}

/** Stage everything and commit at a fixed time with hooks disabled; returns the sha. */
export function commitAt(dir: string, when: Date, message: string): string {
  gitIn(dir, ['add', '-A']);
  const iso = when.toISOString();
  gitIn(dir, [...noHooks(), 'commit', '-q', '-m', message], { GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso });
  return gitIn(dir, ['rev-parse', 'HEAD']).trim();
}

export const at = (base: Date, minutes: number) => new Date(base.getTime() + minutes * 60_000);

type ClaudeEvent =
  | { t: Date; kind: 'prompt'; text: string }
  | { t: Date; kind: 'write'; path: string; content: string }
  | { t: Date; kind: 'bash'; command: string; exitCode: number };

/** A Claude Code session log in <home>/.claude/projects/. */
export function claudeSession(home: string, o: { id: string; cwd: string; model?: string; usage?: boolean; events: ClaudeEvent[] }) {
  const lines: unknown[] = [];
  const common = (t: Date) => ({ sessionId: o.id, cwd: o.cwd, version: '2.1.316', timestamp: t.toISOString(), isSidechain: false });
  let n = 0;
  const usage = o.usage === false ? undefined : { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  for (const e of o.events) {
    n++;
    if (e.kind === 'prompt') {
      lines.push({ type: 'user', uuid: `u${n}`, origin: { kind: 'human' }, message: { role: 'user', content: e.text }, ...common(e.t) });
      continue;
    }
    const input = e.kind === 'write' ? { file_path: e.path, content: e.content } : { command: e.command };
    lines.push({
      type: 'assistant',
      uuid: `a${n}`,
      message: { id: `msg_${n}`, model: o.model ?? 'claude-opus-5-5', role: 'assistant', content: [{ type: 'tool_use', id: `t${n}`, name: e.kind === 'write' ? 'Write' : 'Bash', input }], ...(usage ? { usage } : {}) },
      ...common(e.t),
    });
    const result =
      e.kind === 'write'
        ? { content: [{ type: 'tool_result', tool_use_id: `t${n}`, content: 'ok' }], tur: { type: 'create', filePath: e.path, content: e.content, structuredPatch: [] } }
        : {
            content: [{ type: 'tool_result', tool_use_id: `t${n}`, is_error: e.exitCode !== 0, content: e.exitCode ? `Exit code ${e.exitCode}\nfail` : 'ok' }],
            tur: { stdout: '', stderr: '', interrupted: false },
          };
    lines.push({ type: 'user', uuid: `r${n}`, message: { role: 'user', content: result.content }, toolUseResult: result.tur, ...common(new Date(e.t.getTime() + 1000)) });
  }
  const dir = path.join(home, '.claude', 'projects', o.cwd.replace(/[/\\:.]/g, '-'));
  write(path.join(dir, `${o.id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

type CodexEvent =
  | { t: Date; kind: 'prompt'; text: string }
  | { t: Date; kind: 'update'; path: string; diff: string }
  | { t: Date; kind: 'command'; command: string; exitCode: number };

/** A Codex rollout (newer item_completed format) in <home>/.codex/sessions/. */
export function codexSession(home: string, o: { id: string; cwd: string; model: string; start: Date; events: CodexEvent[] }) {
  const ev = (t: Date, type: string, payload: unknown) => JSON.stringify({ timestamp: t.toISOString(), type, payload });
  const lines = [
    ev(o.start, 'session_meta', { id: o.id, cwd: o.cwd, cli_version: '0.163.0', source: 'cli' }),
    ev(o.start, 'turn_context', { turn_id: 't1', cwd: o.cwd, model: o.model }),
  ];
  let total = 0;
  for (const [i, e] of o.events.entries()) {
    const item =
      e.kind === 'prompt'
        ? { type: 'UserMessage', id: `m${i}`, content: [{ type: 'text', text: e.text }] }
        : e.kind === 'update'
          ? { type: 'FileChange', id: `c${i}`, status: 'completed', changes: { [e.path]: { type: 'update', unified_diff: e.diff, move_path: null } } }
          : { type: 'CommandExecution', id: `x${i}`, command: ['/bin/zsh', '-lc', e.command], cwd: o.cwd, status: 'completed', exit_code: e.exitCode };
    lines.push(ev(e.t, 'event_msg', { type: 'item_completed', item }));
    total += 1000;
    const u = { input_tokens: total, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: total / 10, reasoning_output_tokens: 0, total_tokens: total * 1.1 };
    lines.push(ev(e.t, 'event_msg', { type: 'token_count', info: { total_token_usage: u, last_token_usage: u } }));
  }
  const stamp = o.start.toISOString().slice(0, 19).replace(/:/g, '-');
  write(path.join(home, '.codex', 'sessions', '2026', '10', '01', `rollout-${stamp}-${o.id}.jsonl`), lines.join('\n') + '\n');
}

/** A Gemini CLI chat file keyed by the SHA-256 of the project root. */
export function geminiSession(home: string, o: { id: string; projectRoot: string; model: string; start: Date; messages: unknown[] }) {
  const projectHash = createHash('sha256').update(o.projectRoot).digest('hex');
  const doc = { sessionId: o.id, projectHash, startTime: o.start.toISOString(), lastUpdated: o.start.toISOString(), messages: o.messages };
  write(path.join(home, '.gemini', 'tmp', projectHash, 'chats', `session-${o.id}.json`), JSON.stringify(doc));
}

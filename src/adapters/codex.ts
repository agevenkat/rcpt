import path from 'node:path';
import type { AgentAdapter, AdapterOptions, ParseResult } from './types.js';
import { SessionBuilder, failed } from './builder.js';
import { exists, isObj, num, parseJsonl, readLogText, str, walkFiles, withMtimes } from '../util/read.js';
import { parseApplyPatch, parseUnifiedDiff, type LineDelta } from '../util/lines.js';

// Format notes: docs/log-formats.md#codex-cli
// Two generations coexist: older CLIs log tool calls as response_item/function_call|custom_tool_call;
// newer ones log event_msg/item_completed items (CommandExecution, FileChange). Where both appear they
// share ids, so we union them by id and let the item version win.

const isRollout = (n: string) => n.startsWith('rollout-') && (n.endsWith('.jsonl') || n.endsWith('.jsonl.zst'));

export function codexAdapter({ home, env = process.env }: AdapterOptions): AgentAdapter {
  const dataDir = env.CODEX_HOME || path.join(home, '.codex');
  const dirs = [path.join(dataDir, 'sessions'), path.join(dataDir, 'archived_sessions')];

  return {
    id: 'codex',
    displayName: 'Codex CLI',
    verified: true,
    async detect() {
      return { detected: await exists(dirs[0]!), dataDir: dirs[0]! };
    },
    async listSessions(since) {
      const files = (await Promise.all(dirs.map((d) => walkFiles(d, isRollout, 4)))).flat();
      return withMtimes(files, since);
    },
    async parseSession(file) {
      try {
        return await parse(file);
      } catch (err) {
        return failed(file, err);
      }
    },
  };
}

interface Cmd { ts: string; command: string; cwd: string | null; exitCode: number | null }
interface Edit { ts: string; path: string; kind: 'create' | 'update' | 'delete'; delta: LineDelta; tool: string }

async function parse(file: string): Promise<ParseResult> {
  const id = /([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl/.exec(path.basename(file))?.[1] ?? path.basename(file);
  const b = new SessionBuilder('codex', id, file);
  let model = 'unknown';
  let turnCwd: string | null = null;
  let prevTotal: Record<string, unknown> | null = null;

  const commands = new Map<string, Cmd>();
  const edits = new Map<string, Edit[]>();
  const patchCalls = new Map<string, { ts: string; input: string; cwd: string | null }>();
  const failedCalls = new Set<string>();

  for (const ev of parseJsonl(await readLogText(file), file, b.warnings)) {
    if (!isObj(ev)) continue;
    const type = str(ev.type) ?? '?';
    const p = isObj(ev.payload) ? ev.payload : {};
    const ptype = str(p.type);
    const ts = str(ev.timestamp) ?? '';
    b.seen(ts);

    if (type === 'session_meta') {
      b.id = str(p.id) ?? b.id;
      b.cwd = str(p.cwd) ?? b.cwd;
      turnCwd ??= b.cwd;
      b.agentVersion = str(p.cli_version) ?? null;
    } else if (type === 'turn_context') {
      model = str(p.model) ?? model;
      b.model(model);
      turnCwd = str(p.cwd) ?? turnCwd;
    } else if (type === 'event_msg' && ptype === 'token_count') {
      // total_token_usage is cumulative and is re-emitted unchanged; take deltas to avoid double counting.
      const info = isObj(p.info) ? p.info : null;
      const total = info && isObj(info.total_token_usage) ? info.total_token_usage : null;
      if (!total) continue;
      if (prevTotal && num(total.total_tokens) < num(prevTotal.total_tokens)) {
        b.warnings.push({ path: file, message: 'token total decreased; counter reset assumed' });
        prevTotal = null;
      }
      const d = (k: string) => num(total[k]) - (prevTotal ? num(prevTotal[k]) : 0);
      if (d('total_tokens') > 0) {
        // cached_input_tokens is a subset of input_tokens (verified on observed logs). cache_write was
        // always 0 in observed logs; treated as a subset too (OpenAI input = total prompt tokens).
        b.addUsage(model, {
          input: Math.max(0, d('input_tokens') - d('cached_input_tokens') - d('cache_write_input_tokens')),
          cacheRead: d('cached_input_tokens'),
          cacheWrite: d('cache_write_input_tokens'),
          output: d('output_tokens'),
        }, ts);
      }
      prevTotal = total;
    } else if (type === 'event_msg' && ptype === 'item_completed' && isObj(p.item)) {
      handleItem(b, p.item, ts, commands, edits);
    } else if (type === 'response_item' && (ptype === 'function_call' || ptype === 'custom_tool_call')) {
      const callId = str(p.call_id) ?? '';
      const name = str(p.name);
      if (name === 'apply_patch') {
        const raw = str(p.input) ?? str(p.arguments) ?? '';
        let input = raw;
        try {
          const j: unknown = JSON.parse(raw);
          if (isObj(j)) input = str(j.input) ?? str(j.patch) ?? raw;
        } catch { /* raw patch text */ }
        patchCalls.set(callId, { ts, input, cwd: turnCwd });
      } else if (name === 'exec_command' && !commands.has(callId)) {
        let args: Record<string, unknown> = {};
        try {
          const j: unknown = JSON.parse(str(p.arguments) ?? '{}');
          if (isObj(j)) args = j;
        } catch { /* ignore */ }
        const cmd = Array.isArray(args.cmd) ? unwrapShell(args.cmd) : str(args.cmd);
        if (cmd) commands.set(callId, { ts, command: cmd, cwd: str(args.workdir) ?? turnCwd, exitCode: null });
      } else b.skip(`${type}/${ptype}:${name}`);
    } else if (type === 'response_item' && (ptype === 'function_call_output' || ptype === 'custom_tool_call_output')) {
      const callId = str(p.call_id) ?? '';
      const out = outputText(p.output);
      const exit = /Process exited with code (\d+)/.exec(out) ?? /"exit_code"\s*:\s*(\d+)/.exec(out);
      const c = commands.get(callId);
      if (c && exit && c.exitCode === null) c.exitCode = Number(exit[1]);
      if (patchCalls.has(callId) && exit && exit[1] !== '0') failedCalls.add(callId);
    } else {
      b.skip(ptype ? `${type}/${ptype}` : type);
    }
  }

  for (const [callId, call] of patchCalls) {
    if (edits.has(callId) || failedCalls.has(callId)) continue;
    edits.set(
      callId,
      parseApplyPatch(call.input).map((f) => ({
        ts: call.ts,
        path: call.cwd ? path.resolve(call.cwd, f.path) : f.path,
        kind: f.kind,
        delta: f,
        tool: 'apply_patch',
      })),
    );
  }
  for (const list of edits.values()) for (const e of list) b.edit(e.path, e.ts, e.kind, e.delta, e.tool);
  for (const c of commands.values()) b.command(c.ts, c.command, c.cwd, c.exitCode);
  return b.result();
}

function handleItem(
  b: SessionBuilder,
  item: Record<string, unknown>,
  ts: string,
  commands: Map<string, Cmd>,
  edits: Map<string, Edit[]>,
) {
  const itype = str(item.type) ?? '?';
  const id = str(item.id) ?? `${itype}-${commands.size + edits.size}`;
  if (itype === 'UserMessage') {
    const parts = Array.isArray(item.content) ? item.content.filter(isObj) : [];
    b.prompt(ts, parts.map((x) => (x.type === 'text' ? (str(x.text) ?? '') : '')).join('\n'));
  } else if (itype === 'CommandExecution') {
    const cmd = Array.isArray(item.command) ? unwrapShell(item.command) : str(item.command);
    if (!cmd) return;
    const exitCode = typeof item.exit_code === 'number' ? item.exit_code : null;
    commands.set(id, { ts, command: cmd, cwd: str(item.cwd) ?? null, exitCode });
  } else if (itype === 'FileChange') {
    if (item.status !== 'completed' || !isObj(item.changes)) return;
    const list: Edit[] = [];
    for (const [p, ch] of Object.entries(item.changes)) {
      if (!isObj(ch)) continue;
      const t = str(ch.type);
      const content = str(ch.content) ?? '';
      if (t === 'add') list.push({ ts, path: p, kind: 'create', delta: { added: content.split('\n'), removed: [] }, tool: 'FileChange' });
      else if (t === 'delete') list.push({ ts, path: p, kind: 'delete', delta: { added: [], removed: content.split('\n') }, tool: 'FileChange' });
      else if (t === 'update') {
        list.push({ ts, path: str(ch.move_path) ?? p, kind: 'update', delta: parseUnifiedDiff(str(ch.unified_diff) ?? ''), tool: 'FileChange' });
      } else b.skip(`FileChange:${t}`);
    }
    edits.set(id, list);
  } else {
    b.skip(`item:${itype}`);
  }
}

/** ["/bin/zsh", "-lc", "npm test"] -> "npm test" */
function unwrapShell(argv: unknown[]): string {
  const a = argv.filter((x): x is string => typeof x === 'string');
  const i = a.findIndex((x) => x === '-c' || x === '-lc');
  return i >= 0 && a[i + 1] ? a[i + 1]! : a.join(' ');
}

function outputText(out: unknown): string {
  if (typeof out === 'string') return out;
  if (Array.isArray(out)) return out.map((x) => (isObj(x) ? (str(x.text) ?? '') : '')).join('\n');
  return '';
}

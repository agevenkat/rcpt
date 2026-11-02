import path from 'node:path';
import type { AgentAdapter, AdapterOptions, ParseResult } from './types.js';
import { SessionBuilder, failed } from './builder.js';
import { exists, isObj, num, parseJsonl, readLogText, str, walkFiles, withMtimes } from '../util/read.js';
import { diffStrings, parseDiffLines, type LineDelta } from '../util/lines.js';

// Format notes: docs/log-formats.md#claude-code
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write']);

interface PendingTool {
  name: string;
  input: Record<string, unknown>;
}

export function claudeCodeAdapter({ home, env = process.env }: AdapterOptions): AgentAdapter {
  const dataDir = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const projectsDir = path.join(dataDir, 'projects');

  return {
    id: 'claude-code',
    displayName: 'Claude Code',
    verified: true,
    async detect() {
      return { detected: await exists(projectsDir), dataDir: projectsDir };
    },
    async listSessions(since) {
      // Top-level <project>/<session>.jsonl only; subagent logs are merged into their parent.
      const files = await walkFiles(projectsDir, (n) => n.endsWith('.jsonl'), 1);
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

async function parse(file: string): Promise<ParseResult> {
  const b = new SessionBuilder('claude-code', path.basename(file, '.jsonl'), file);
  const subagentFiles = await walkFiles(path.join(file.replace(/\.jsonl$/, ''), 'subagents'), (n) => n.endsWith('.jsonl'), 0);

  // Assistant messages are split across several lines that repeat the same usage; keep one per message id.
  const usageById = new Map<string, { model: string; usage: Record<string, unknown>; ts: string }>();
  let anon = 0;

  for (const [i, f] of [file, ...subagentFiles].entries()) {
    const isSubagent = i > 0;
    if (isSubagent) b.session.sourcePaths.push(f);
    const pending = new Map<string, PendingTool>();
    for (const ev of parseJsonl(await readLogText(f), f, b.warnings)) {
      if (!isObj(ev)) continue;
      const type = str(ev.type) ?? '?';
      if (type !== 'user' && type !== 'assistant') {
        b.skip(type);
        continue;
      }
      const ts = str(ev.timestamp) ?? '';
      b.seen(ts);
      if (!isSubagent) {
        b.agentVersion ??= str(ev.version) ?? null;
        b.cwd ??= str(ev.cwd) ?? null;
        if (str(ev.sessionId)) b.id = str(ev.sessionId)!;
      }
      const msg = isObj(ev.message) ? ev.message : {};

      if (type === 'assistant') {
        const model = str(msg.model) ?? 'unknown';
        b.model(model);
        // "<synthetic>" marks locally generated messages (no API call, no usage).
        if (isObj(msg.usage) && !model.startsWith('<')) {
          const key = str(msg.id) ?? `anon-${anon++}`;
          usageById.set(key, { model, usage: msg.usage, ts: usageById.get(key)?.ts ?? ts });
        }
        for (const block of Array.isArray(msg.content) ? msg.content : []) {
          if (isObj(block) && block.type === 'tool_use' && str(block.id)) {
            pending.set(str(block.id)!, { name: str(block.name) ?? '?', input: isObj(block.input) ? block.input : {} });
          }
        }
        continue;
      }

      // user event: either a human prompt or tool results
      const content = msg.content;
      const blocks = Array.isArray(content) ? content.filter(isObj) : [];
      const results = blocks.filter((x) => x.type === 'tool_result');
      if (!results.length) {
        if (!isSubagent && isHumanPrompt(ev)) {
          const text = typeof content === 'string' ? content : blocks.map((x) => str(x.text) ?? '').join('\n');
          b.prompt(ts, text);
        }
        continue;
      }
      const tur = isObj(ev.toolUseResult) ? ev.toolUseResult : {};
      for (const r of results) {
        const tool = pending.get(str(r.tool_use_id) ?? '');
        if (!tool) continue;
        pending.delete(str(r.tool_use_id)!);
        handleToolResult(b, tool, r, tur, ts, str(ev.cwd) ?? b.cwd);
      }
    }
    if (pending.size) b.skip('tool_use-without-result');
  }

  for (const { model, usage, ts } of usageById.values()) {
    const write = num(usage.cache_creation_input_tokens);
    const write1h = Math.min(write, num(isObj(usage.cache_creation) ? usage.cache_creation.ephemeral_1h_input_tokens : 0));
    b.addUsage(model, {
      input: num(usage.input_tokens),
      output: num(usage.output_tokens),
      cacheRead: num(usage.cache_read_input_tokens),
      cacheWrite: write - write1h,
      cacheWrite1h: write1h,
    }, ts);
  }
  return b.result();
}

function isHumanPrompt(ev: Record<string, unknown>): boolean {
  if (ev.isMeta === true || ev.isSidechain === true) return false;
  const kind = isObj(ev.origin) ? str(ev.origin.kind) : undefined;
  return kind === undefined || kind === 'human';
}

function handleToolResult(
  b: SessionBuilder,
  tool: PendingTool,
  result: Record<string, unknown>,
  tur: Record<string, unknown>,
  ts: string,
  cwd: string | null,
) {
  const isError = result.is_error === true;

  if (tool.name === 'Bash') {
    const cmd = str(tool.input.command);
    if (cmd) b.command(ts, cmd, cwd, bashExitCode(isError, result, tur));
    // Claude Code records files that a Bash command modified (e.g. sed -i) with hunks.
    const bed = isObj(tur.bashEditDiff) ? tur.bashEditDiff : null;
    for (const f of bed && Array.isArray(bed.files) ? bed.files.filter(isObj) : []) {
      const lines = (Array.isArray(f.hunks) ? f.hunks.filter(isObj) : []).flatMap((h) =>
        Array.isArray(h.lines) ? h.lines.filter((l): l is string => typeof l === 'string') : [],
      );
      const kind = f.created === true ? 'create' : f.deleted === true ? 'delete' : 'update';
      if (str(f.filePath)) b.edit(str(f.filePath)!, ts, kind, parseDiffLines(lines), 'bash');
    }
    return;
  }

  if (!EDIT_TOOLS.has(tool.name) || isError) return;
  const filePath = str(tur.filePath) ?? str(tool.input.file_path);
  if (!filePath) return;
  const created = tur.type === 'create';
  b.edit(filePath, ts, created ? 'create' : 'update', editDelta(tool, tur), tool.name);
}

function editDelta(tool: PendingTool, tur: Record<string, unknown>): LineDelta {
  // Preferred: the result's own record of what changed.
  if (tur.type === 'create' && typeof tur.content === 'string') return { added: tur.content.split('\n'), removed: [] };
  if (Array.isArray(tur.structuredPatch)) {
    const lines = tur.structuredPatch
      .filter(isObj)
      .flatMap((h) => (Array.isArray(h.lines) ? h.lines.filter((l): l is string => typeof l === 'string') : []));
    return parseDiffLines(lines);
  }
  // Fallback: reconstruct from tool input.
  const inp = tool.input;
  if (tool.name === 'Write' && typeof inp.content === 'string') return { added: inp.content.split('\n'), removed: [] };
  const pairs = tool.name === 'MultiEdit' && Array.isArray(inp.edits) ? inp.edits.filter(isObj) : [inp];
  const out: LineDelta = { added: [], removed: [] };
  for (const p of pairs) {
    const d = diffStrings(str(p.old_string) ?? '', str(p.new_string) ?? '');
    out.added.push(...d.added);
    out.removed.push(...d.removed);
  }
  return out;
}

function bashExitCode(isError: boolean, result: Record<string, unknown>, tur: Record<string, unknown>): number | null {
  if (tur.interrupted === true) return null;
  if (!isError) return 0;
  const c = result.content;
  const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (isObj(x) ? (str(x.text) ?? '') : '')).join('') : '';
  const m = /^Exit code (\d+)/.exec(text);
  return m ? Number(m[1]) : null;
}

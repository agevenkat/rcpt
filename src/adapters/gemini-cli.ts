import path from 'node:path';
import type { AgentAdapter, AdapterOptions, ParseResult } from './types.js';
import { SessionBuilder, failed } from './builder.js';
import { exists, isObj, num, readLogText, str, walkFiles, withMtimes } from '../util/read.js';
import { diffStrings, parseUnifiedDiff, type LineDelta } from '../util/lines.js';

// UNVERIFIED: built from Gemini CLI's documented chat-recording format, not observed logs.
// See docs/log-formats.md#gemini-cli. Every field access is defensive.

const isChat = (n: string) => n.startsWith('session-') && n.endsWith('.json');

export function geminiCliAdapter({ home }: AdapterOptions): AgentAdapter {
  const tmpDir = path.join(home, '.gemini', 'tmp');

  return {
    id: 'gemini-cli',
    displayName: 'Gemini CLI',
    verified: false,
    async detect() {
      return { detected: await exists(tmpDir), dataDir: tmpDir };
    },
    async listSessions(since) {
      // ~/.gemini/tmp/<projectHash>/chats/session-*.json
      const files = await walkFiles(tmpDir, isChat, 2);
      return withMtimes(files.filter((f) => path.basename(path.dirname(f)) === 'chats'), since);
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
  const b = new SessionBuilder('gemini-cli', path.basename(file, '.json'), file);
  let doc: unknown;
  try {
    doc = JSON.parse(await readLogText(file));
  } catch {
    // A file being written mid-session can be truncated.
    b.warnings.push({ path: file, message: 'unparseable session JSON; skipped' });
    return b.result();
  }
  if (!isObj(doc) || !Array.isArray(doc.messages)) {
    b.warnings.push({ path: file, message: 'unexpected session shape (no messages array)' });
    return b.result();
  }
  b.id = str(doc.sessionId) ?? b.id;
  b.projectHash = str(doc.projectHash) ?? path.basename(path.dirname(path.dirname(file)));
  b.seen(doc.startTime);
  b.seen(doc.lastUpdated);
  // The documented chat format has no CLI version field; agentVersion stays null.

  for (const [i, m] of doc.messages.entries()) {
    if (!isObj(m)) {
      b.warnings.push({ path: file, line: i, message: 'skipped non-object message' });
      continue;
    }
    const ts = str(m.timestamp) ?? '';
    b.seen(ts);
    const type = str(m.type) ?? '?';
    if (type === 'user') {
      b.prompt(ts, contentText(m.content));
    } else if (type === 'gemini') {
      const model = str(m.model) ?? 'unknown';
      b.model(model);
      if (isObj(m.tokens)) {
        const t = m.tokens;
        // Assumption: `input` includes `cached` (as in the Gemini API usage metadata); thoughts bill as output.
        b.addUsage(model, {
          input: Math.max(0, num(t.input) - num(t.cached)) + num(t.tool),
          cacheRead: num(t.cached),
          output: num(t.output) + num(t.thoughts),
        }, ts);
      }
      for (const call of Array.isArray(m.toolCalls) ? m.toolCalls.filter(isObj) : []) handleToolCall(b, call, ts);
    } else {
      b.skip(`message:${type}`);
    }
  }
  return b.result();
}

function handleToolCall(b: SessionBuilder, call: Record<string, unknown>, fallbackTs: string) {
  const name = str(call.name) ?? '?';
  const args = isObj(call.args) ? call.args : {};
  const ts = str(call.timestamp) ?? fallbackTs;
  const ok = call.status === undefined || call.status === 'success';

  if (name === 'run_shell_command') {
    const cmd = str(args.command);
    if (!cmd) return;
    const text = JSON.stringify(call.result ?? '') + JSON.stringify(call.resultDisplay ?? '');
    const m = /Exit Code: (\d+)/.exec(text);
    const exitCode = m ? Number(m[1]) : call.status === 'success' ? 0 : null;
    b.command(ts, cmd, str(args.directory) ?? null, exitCode);
    return;
  }
  if ((name === 'write_file' || name === 'replace') && ok) {
    const filePath = str(args.file_path) ?? str(args.absolute_path);
    if (!filePath) return;
    const rd = isObj(call.resultDisplay) ? call.resultDisplay : {};
    let delta: LineDelta;
    if (str(rd.fileDiff)) delta = parseUnifiedDiff(str(rd.fileDiff)!);
    else if (name === 'write_file') delta = { added: (str(args.content) ?? '').split('\n'), removed: [] };
    else delta = diffStrings(str(args.old_string) ?? '', str(args.new_string) ?? '');
    const kind = name === 'write_file' && rd.originalContent == null && !str(rd.fileDiff) ? 'create' : 'update';
    b.edit(filePath, ts, kind, delta, name);
    return;
  }
  b.skip(`tool:${name}`);
}

function contentText(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (isObj(p) ? (str(p.text) ?? '') : '')).join('\n');
  return '';
}

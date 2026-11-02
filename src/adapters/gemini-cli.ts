import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentAdapter, AdapterOptions, ParseResult } from './types.js';
import { SessionBuilder, failed } from './builder.js';
import { exists, isObj, num, parseJsonl, readLogText, str, walkFiles, withMtimes } from '../util/read.js';
import { diffStrings, parseUnifiedDiff, type LineDelta } from '../util/lines.js';

// PARTLY VERIFIED (Gemini CLI 0.66.0): location, JSONL envelope, user/model/error messages, token counts,
// streamed rewrites and $rewindTo were observed. File-writing and shell tool calls (write_file, replace,
// run_shell_command) were not yet observed and follow the documented format. See docs/log-formats.md#gemini-cli.
// Two layouts are supported:
//   0.66+: tmp/<project-name>/chats/session-*.jsonl, with tmp/<project-name>/.project_root holding the path
//   older (documented): tmp/<sha256(project root)>/chats/session-*.json, one JSON document

const isChat = (n: string) => n.startsWith('session-') && (n.endsWith('.json') || n.endsWith('.jsonl'));

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
      // ~/.gemini/tmp/<project>/chats/session-*.json(l)
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

/** Read a session in either layout into { header, messages }. Later lines for the same message id replace earlier ones. */
async function load(file: string, b: SessionBuilder): Promise<{ header: Record<string, unknown>; messages: unknown[] } | null> {
  const text = await readLogText(file);
  if (!file.endsWith('.jsonl')) {
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch {
      // A file being written mid-session can be truncated.
      b.warnings.push({ path: file, message: 'unparseable session JSON; skipped' });
      return null;
    }
    if (!isObj(doc) || !Array.isArray(doc.messages)) {
      b.warnings.push({ path: file, message: 'unexpected session shape (no messages array)' });
      return null;
    }
    return { header: doc, messages: doc.messages };
  }
  const header: Record<string, unknown> = {};
  const byId = new Map<string, Record<string, unknown>>();
  const order: string[] = [];
  let anon = 0;
  for (const line of parseJsonl(text, file, b.warnings)) {
    if (!isObj(line)) continue;
    if (typeof line.$rewindTo === 'string') {
      // Retry/rewind (observed after failed requests): history is cut back to that message. Prompts after it
      // are dropped so a retried prompt isn't counted twice. Model messages stay: their tokens were spent and
      // their edits may be on disk (line matching against the commit decides).
      const at = order.indexOf(line.$rewindTo);
      if (at >= 0) {
        for (const id of order.splice(at + 1)) if (byId.get(id)?.type === 'user') byId.delete(id);
        b.skip('$rewindTo');
      } else b.skip('$rewindTo:unknown-id');
    } else if (isObj(line.$set)) {
      // Header updates, e.g. { "$set": { "lastUpdated": … } }
      for (const [k, v] of Object.entries(line.$set)) {
        if (k === 'lastUpdated') b.seen(v);
        else b.skip(`$set:${k}`);
      }
    } else if (typeof line.type === 'string') {
      const id = str(line.id) ?? `anon-${anon++}`;
      if (!byId.has(id)) order.push(id);
      byId.set(id, line);
    } else if (str(line.sessionId)) {
      Object.assign(header, line);
    } else {
      b.skip('unknown-line');
    }
  }
  return { header, messages: [...byId.values()] };
}

/** 0.66+ keeps the project's absolute path next to the chats folder. */
async function projectRoot(file: string): Promise<string | null> {
  try {
    const p = (await fs.readFile(path.join(path.dirname(path.dirname(file)), '.project_root'), 'utf8')).trim();
    return p && path.isAbsolute(p) ? p : null;
  } catch {
    return null;
  }
}

async function parse(file: string): Promise<ParseResult> {
  const b = new SessionBuilder('gemini-cli', path.basename(file).replace(/\.jsonl?$/, ''), file);
  const loaded = await load(file, b);
  if (!loaded) return b.result();
  const { header, messages } = loaded;
  b.id = str(header.sessionId) ?? b.id;
  b.cwd = await projectRoot(file);
  b.projectHash = str(header.projectHash) ?? path.basename(path.dirname(path.dirname(file)));
  b.seen(header.startTime);
  b.seen(header.lastUpdated);
  // No CLI version field in either layout; agentVersion stays null.

  for (const [i, m] of messages.entries()) {
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

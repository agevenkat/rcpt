import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createAdapters } from '../src/adapters/index.js';
import type { AgentAdapter } from '../src/adapters/types.js';
import { zstdSupported } from '../src/util/read.js';

const HOME = path.join(import.meta.dirname, 'fixtures', 'home');
const adapter = (id: string, home = HOME): AgentAdapter => createAdapters({ home, env: {} }).find((a) => a.id === id)!;

async function parseOnly(id: string) {
  const a = adapter(id);
  const refs = await a.listSessions();
  expect(refs).toHaveLength(1);
  return a.parseSession(refs[0]!.path);
}

describe('claude-code adapter', () => {
  it('detects and lists top-level sessions only (subagent logs are merged)', async () => {
    const a = adapter('claude-code');
    expect((await a.detect()).detected).toBe(true);
    expect(await a.listSessions()).toHaveLength(1);
  });

  it('parses a session including its subagent log', async () => {
    const { session: s, warnings, skippedEvents } = await parseOnly('claude-code');
    expect(s).not.toBeNull();
    expect(s!.id).toBe('11111111-1111-4111-8111-111111111111');
    expect(s!.agentVersion).toBe('2.1.316');
    expect(s!.cwd).toBe('/tmp/demo-repo');
    expect(s!.models.sort()).toEqual(['claude-haiku-5-5', 'claude-opus-5-5']);
    expect(s!.startedAt).toBe('2026-10-01T10:00:00.000Z');
    expect(s!.endedAt).toBe('2026-10-01T10:00:09.000Z');
    expect(s!.sourcePaths).toHaveLength(2);

    // Usage: split assistant lines sharing a message id count once; <synthetic> is excluded.
    expect(s!.tokenUsage).toEqual({
      'claude-opus-5-5': { input: 120, output: 80, cacheRead: 4900, cacheWrite: 200, cacheWrite1h: 300 },
      'claude-haiku-5-5': { input: 30, output: 10, cacheRead: 0, cacheWrite: 500, cacheWrite1h: 0 },
    });

    // Only the typed human prompt, redacted. Meta, subagent instructions and `!` shell echoes are not prompts.
    expect(s!.prompts).toHaveLength(1);
    expect(s!.prompts[0]!.text).toContain('[REDACTED:anthropic-key]');
    expect(s!.prompts[0]!.text).toContain('[REDACTED:email]');
    expect(s!.prompts[0]!.text).not.toMatch(/sk-ant|dev@example/);

    expect(s!.fileEdits.map((e) => [path.basename(e.path), e.kind, e.tool, e.linesAdded, e.linesRemoved])).toEqual([
      ['math.js', 'create', 'Write', 3, 0],
      ['README.md', 'update', 'Edit', 1, 0],
      ['math.js', 'update', 'bash', 1, 1],
      ['util.js', 'create', 'Write', 1, 0],
    ]);
    expect(s!.fileEdits[0]!.addedLineHashes).toHaveLength(3);
    // Usage timeline: one event per API message, ordered, with the first-seen timestamp.
    expect(s!.usageEvents.map((e) => [e.timestamp, e.model])).toEqual([
      ['2026-10-01T10:00:01.000Z', 'claude-opus-5-5'],
      ['2026-10-01T10:00:02.200Z', 'claude-haiku-5-5'],
      ['2026-10-01T10:00:03.000Z', 'claude-opus-5-5'],
      ['2026-10-01T10:00:05.000Z', 'claude-opus-5-5'],
      ['2026-10-01T10:00:07.000Z', 'claude-opus-5-5'],
    ]);

    expect(s!.commandsRun.map((c) => [c.exitCode, c.isTest])).toEqual([
      [1, true],
      [0, true],
    ]);

    expect(warnings).toEqual([expect.objectContaining({ line: 12, message: 'skipped unparseable line' })]);
    expect(skippedEvents).toMatchObject({ 'permission-mode': 1, 'future-event-type': 1 });
  });
});

describe('codex adapter', () => {
  it('lists both rollout files', async () => {
    expect(await adapter('codex').listSessions()).toHaveLength(2);
  });

  async function byId(idPart: string) {
    const a = adapter('codex');
    const ref = (await a.listSessions()).find((r) => r.path.includes(idPart))!;
    return a.parseSession(ref.path);
  }

  it('parses the item_completed format (newer CLIs)', async () => {
    const { session: s, warnings, skippedEvents } = await byId('22222222');
    expect(s!.id).toBe('22222222-2222-4222-8222-222222222222');
    expect(s!.agentVersion).toBe('0.163.0');
    expect(s!.models).toEqual(['gpt-6-luna']);
    // Cumulative totals re-emitted unchanged are not double counted; cached and cache-write are split out of input.
    expect(s!.tokenUsage).toEqual({ 'gpt-6-luna': { input: 950, output: 300, cacheRead: 2000, cacheWrite: 50, cacheWrite1h: 0 } });
    expect(s!.prompts).toHaveLength(1);
    expect(s!.prompts[0]!.text).toContain('GITHUB_TOKEN=[REDACTED:github-token]');
    expect(s!.fileEdits.map((e) => [e.path, e.kind, e.linesAdded])).toEqual([
      ['/tmp/demo-repo/sub.js', 'create', 3],
      ['/tmp/demo-repo/README.md', 'update', 1],
    ]);
    expect(s!.commandsRun).toEqual([
      expect.objectContaining({ command: 'npm test', exitCode: 0, isTest: true, cwd: '/tmp/demo-repo' }),
    ]);
    expect(warnings).toHaveLength(1);
    expect(skippedEvents['future_event/something_new']).toBe(1);
  });

  it('parses the function_call/apply_patch format (older CLIs)', async () => {
    const { session: s, warnings } = await byId('33333333');
    expect(warnings).toEqual([]);
    expect(s!.agentVersion).toBe('0.107.0');
    expect(s!.prompts.map((p) => p.text)).toEqual(['Write a python helper and run pytest']);
    // Relative patch paths resolve against the turn cwd; the failed patch is ignored.
    expect(s!.fileEdits.map((e) => [e.path, e.kind, e.linesAdded])).toEqual([
      [path.resolve('/tmp/demo-repo', 'pkg/helper.py'), 'create', 2],
      [path.resolve('/tmp/demo-repo', 'README.md'), 'update', 1],
    ]);
    expect(s!.commandsRun).toEqual([expect.objectContaining({ command: 'pytest -q', exitCode: 2, isTest: true })]);
    expect(s!.tokenUsage).toEqual({ 'gpt-5.3-codex': { input: 500, output: 80, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 } });
  });

  it.runIf(zstdSupported)('reads zstd-compressed rollouts', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rcpt-zst-'));
    const dir = path.join(tmp, '.codex', 'sessions', '2026', '10', '01');
    fs.mkdirSync(dir, { recursive: true });
    const src = path.join(HOME, '.codex/sessions/2026/10/01/rollout-2026-10-01T12-00-00-33333333-3333-4333-8333-333333333333.jsonl');
    const compress = (zlib as unknown as { zstdCompressSync: (b: Buffer) => Buffer }).zstdCompressSync;
    fs.writeFileSync(path.join(dir, path.basename(src) + '.zst'), compress(fs.readFileSync(src)));
    const a = adapter('codex', tmp);
    const [ref] = await a.listSessions();
    const { session } = await a.parseSession(ref!.path);
    expect(session!.id).toBe('33333333-3333-4333-8333-333333333333');
    expect(session!.fileEdits).toHaveLength(2);
    fs.rmSync(tmp, { recursive: true });
  });
});

describe('gemini-cli adapter (unverified)', () => {
  it('is marked unverified', () => {
    expect(adapter('gemini-cli').verified).toBe(false);
  });

  async function byName(part: string) {
    const a = adapter('gemini-cli');
    const refs = await a.listSessions();
    expect(refs).toHaveLength(2);
    return a.parseSession(refs.find((r) => r.path.includes(part))!.path);
  }

  it('parses the 0.66 JSONL layout (observed envelope) and reads .project_root', async () => {
    const { session: s, warnings, skippedEvents } = await byName('5555aaaa');
    expect(s!.id).toBe('55555555-5555-4555-8555-555555555555');
    expect(s!.cwd).toBe('/tmp/demo-repo');
    // u1 survives (the rewind target i1 comes after it); the retried prompt u1b is the second one.
    expect(s!.prompts.map((p) => p.text)).toEqual(['Add a divide function. token: [REDACTED:github-token]', 'Add a divide function (retry)']);
    // A message rewritten under the same id counts once (the last version).
    expect(s!.tokenUsage).toEqual({ 'gemini-3.8-flash': { input: 1000, output: 100, cacheRead: 200, cacheWrite: 0, cacheWrite1h: 0 } });
    expect(s!.fileEdits.map((e) => [path.basename(e.path), e.kind, e.linesAdded])).toEqual([['div.js', 'create', 1]]);
    expect(s!.endedAt).toBe('2026-11-02T10:16:06.000Z');
    expect(warnings).toEqual([expect.objectContaining({ message: 'skipped unparseable line' })]);
    expect(skippedEvents).toMatchObject({ 'message:info': 1, 'message:error': 1, '$rewindTo': 1, '$set:newField': 1 });
  });

  it('parses a documented-format chat file', async () => {
    const { session: s, warnings, skippedEvents } = await byName('abcd1234');
    expect(s!.id).toBe('44444444-4444-4444-8444-444444444444');
    expect(s!.cwd).toBeNull();
    expect(s!.projectHash).toMatch(/^0f0f/);
    expect(s!.models).toEqual(['gemini-3-pro']);
    expect(s!.tokenUsage).toEqual({ 'gemini-3-pro': { input: 1500, output: 200, cacheRead: 500, cacheWrite: 0, cacheWrite1h: 0 } });
    expect(s!.prompts[0]!.text).toBe('Add a multiply function. password=[REDACTED:secret]');
    expect(s!.fileEdits.map((e) => [path.basename(e.path), e.kind, e.linesAdded])).toEqual([
      ['mul.js', 'create', 1],
      ['README.md', 'update', 1],
    ]);
    expect(s!.commandsRun).toEqual([expect.objectContaining({ command: 'npm test', exitCode: 0, isTest: true })]);
    expect(warnings).toHaveLength(1);
    expect(skippedEvents).toMatchObject({ 'tool:google_web_search': 1, 'message:info': 1 });
  });
});

describe('robustness', () => {
  it('never throws on garbage, missing, or empty files', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rcpt-bad-'));
    const garbage = path.join(tmp, 'garbage.jsonl');
    const empty = path.join(tmp, 'empty.jsonl');
    fs.writeFileSync(garbage, '\u0000\u0001not json\n{{{\n');
    fs.writeFileSync(empty, '');
    for (const a of createAdapters({ home: tmp, env: {} })) {
      for (const f of [garbage, empty, path.join(tmp, 'missing.jsonl')]) {
        const r = await a.parseSession(f);
        expect(r.session).toBeNull();
        expect(r.warnings.length).toBeGreaterThan(0);
      }
      expect((await a.detect()).detected).toBe(false);
      expect(await a.listSessions()).toEqual([]);
    }
    fs.rmSync(tmp, { recursive: true });
  });
});

import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { redact } from '../src/util/redact.js';
import { isTestCommand } from '../src/util/test-commands.js';
import { diffStrings, hashLine, parseApplyPatch, parseUnifiedDiff } from '../src/util/lines.js';
import { sinceDate } from '../src/util/duration.js';
import { formatDoctor, runDoctor } from '../src/doctor.js';
import { createAdapters } from '../src/adapters/index.js';

describe('redact', () => {
  it.each([
    ['sk-ant-api03-abcdefghijklmnopqrstuv', 'anthropic-key'],
    ['sk-proj-abcdefghijklmnopqrstuvwxyz', 'openai-key'],
    ['ghp_abcdefghijklmnopqrstuvwxyz0123', 'github-token'],
    ['AKIAABCDEFGHIJKLMNOP', 'aws-access-key'],
    ['xoxb-1234567890-abcdefghij', 'slack-token'],
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop', 'jwt'],
    ['someone@example.com', 'email'],
  ])('redacts %s', (secret, label) => {
    const out = redact(`before ${secret} after`);
    expect(out).toBe(`before [REDACTED:${label}] after`);
  });

  it('redacts .env-style assignments and keeps the key name', () => {
    expect(redact('DATABASE_PASSWORD=s3cr3t-value')).toBe('DATABASE_PASSWORD=[REDACTED:secret]');
    expect(redact('api_key: "abcd1234"')).toBe('api_key: "[REDACTED:secret]"');
    expect(redact('--auth-token abcdef123')).toBe('--auth-token [REDACTED:secret]');
  });

  it('redacts private key blocks and URL credentials', () => {
    const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\nBBBB\n-----END OPENSSH PRIVATE KEY-----';
    expect(redact(`key:\n${key}\nend`)).toBe('key:\n[REDACTED:private-key]\nend');
    expect(redact('postgres://admin:pw123@db.local/x')).toBe('postgres://[REDACTED:url-credentials]@db.local/x');
  });

  it('leaves ordinary text and git SHAs alone', () => {
    const t = 'fix the bug in src/app.ts at commit 3f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39';
    expect(redact(t)).toBe(t);
  });
});

describe('isTestCommand', () => {
  it.each([
    'npm test', 'npm run test', 'pnpm test -- --watch=false', 'yarn test', 'bun test',
    'npx vitest run', 'jest --ci', 'pytest -q', 'python -m pytest tests/', 'go test ./...',
    'cargo test', 'cargo nextest run', './gradlew test', 'mvn -q verify', 'bundle exec rspec',
    'dotnet test', 'make test', 'cd web && npm test', 'CI=1 npm test', 'npm run test:unit',
  ])('recognizes %s', (c) => expect(isTestCommand(c)).toBe(true));

  it.each(['npm install', 'git status', 'echo pytest', 'cat test.txt', 'npm run build', 'ls tests/'])(
    'ignores %s',
    (c) => expect(isTestCommand(c)).toBe(false),
  );

  it('accepts extra patterns', () => {
    expect(isTestCommand('./scripts/check.sh', [/^\.\/scripts\/check\.sh\b/])).toBe(true);
  });
});

describe('line utilities', () => {
  it('hashes normalized lines and skips blanks', () => {
    expect(hashLine('  return  a + b; ')).toBe(hashLine('return a + b;'));
    expect(hashLine('   ')).toBeNull();
  });

  it('parses unified diffs without counting headers', () => {
    expect(parseUnifiedDiff('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n ctx')).toEqual({ added: ['new'], removed: ['old'] });
  });

  it('diffs old/new strings as multisets', () => {
    expect(diffStrings('a\nb\nc', 'a\nB\nc\nd')).toEqual({ added: ['B', 'd'], removed: ['b'] });
  });

  it('parses apply_patch with add, update, move and delete', () => {
    const files = parseApplyPatch(
      '*** Begin Patch\n*** Add File: a.txt\n+one\n*** Update File: b.txt\n*** Move to: c.txt\n@@ ctx\n-x\n+y\n*** Delete File: d.txt\n*** End Patch',
    );
    expect(files).toEqual([
      { path: 'a.txt', kind: 'create', added: ['one'], removed: [] },
      { path: 'c.txt', kind: 'update', added: ['y'], removed: ['x'] },
      { path: 'd.txt', kind: 'delete', added: [], removed: [] },
    ]);
  });
});

describe('sinceDate', () => {
  it('parses durations', () => {
    expect(sinceDate('2d', 10 * 86_400_000).getTime()).toBe(8 * 86_400_000);
    expect(() => sinceDate('soon')).toThrow(/invalid duration/);
  });
});

describe('doctor', () => {
  it('reports every agent against the fixture home', async () => {
    const home = path.join(import.meta.dirname, 'fixtures', 'home');
    const reports = await runDoctor(createAdapters({ home, env: {} }), new Date(0));
    const by = Object.fromEntries(reports.map((r) => [r.agent, r]));
    expect(by['claude-code']).toMatchObject({ detected: true, totalSessions: 1, parsed: 1, fileEdits: 4, testCommands: 2 });
    expect(by['codex']).toMatchObject({ detected: true, totalSessions: 2, parsed: 2, versions: ['0.107.0', '0.163.0'] });
    expect(by['gemini-cli']).toMatchObject({ detected: true, verified: false, parsed: 2 });
    expect(by['claude-code']!.warnings).toEqual([{ message: 'skipped unparseable line', count: 1 }]);

    const text = formatDoctor(reports, '30d');
    expect(text).toContain('✓ Gemini CLI (unverified)');
    expect(text).toContain('1× skipped unparseable line');
  });
});

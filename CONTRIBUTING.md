# Contributing to rcpt

```sh
npm install
npm run check   # lint + typecheck + tests (the tests build dist/ first)
npm run dev -- doctor
```

CI runs the same checks on Linux, macOS and Windows with Node 22 and 24. If you change `action/src` or anything it imports, run `npm run build` and commit `action/dist/index.js`. CI fails if the bundle is stale.

## Adding an agent adapter

An adapter turns one agent's session logs into the common `AgentSession` shape (`src/types.ts`). Attribution, receipts and reports work unchanged once the adapter exists.

### 1. Look at real logs first

Don't write a parser from memory or blog posts. Formats are undocumented and change between versions.

1. Find where the agent stores sessions on a machine where it's installed.
2. Record the **structure** of a few real files: key paths, value types, event-type counts. Never record prompt text, code or real paths. A quick way is to walk each JSON object and print `path:type` pairs (see how `docs/log-formats.md` describes Claude Code and Codex).
3. Write a new section in `docs/log-formats.md` with the location, the format, the versions you observed, and any counter semantics you verified (for example, "totals are cumulative and repeat; take deltas").

If you can't get real logs, build from the vendor's documentation and set `verified: false`. `doctor` and the README will show the adapter as unverified.

### 2. Implement `AgentAdapter`

Create `src/adapters/<agent>.ts`:

```ts
import path from 'node:path';
import type { AgentAdapter, AdapterOptions } from './types.js';
import { SessionBuilder, failed } from './builder.js';
import { exists, isObj, parseJsonl, readLogText, str, walkFiles, withMtimes } from '../util/read.js';

export function myAgentAdapter({ home }: AdapterOptions): AgentAdapter {
  const dir = path.join(home, '.myagent', 'sessions');
  return {
    id: 'my-agent',
    displayName: 'My Agent',
    verified: true, // only if checked against real logs
    async detect() {
      return { detected: await exists(dir), dataDir: dir };
    },
    async listSessions(since) {
      return withMtimes(await walkFiles(dir, (n) => n.endsWith('.jsonl')), since);
    },
    async parseSession(file) {
      try {
        const b = new SessionBuilder('my-agent', path.basename(file), file);
        for (const ev of parseJsonl(await readLogText(file), file, b.warnings)) {
          if (!isObj(ev)) continue;
          b.seen(ev.timestamp);
          // b.prompt(ts, text)  b.model(name)  b.addUsage(model, tokens, ts)
          // b.edit(absPath, ts, kind, { added, removed }, tool)  b.command(ts, cmd, cwd, exitCode)
          // anything you don't use: b.skip(type)
        }
        return b.result();
      } catch (err) {
        return failed(file, err);
      }
    },
  };
}
```

Then add it to `FACTORIES` in `src/adapters/index.ts`. That's the only other change.

Rules every adapter follows:

- **`parseSession` never throws.** Bad lines become warnings, and unknown event types go through `b.skip(type)`.
- **Prompts and commands go through the builder**, which redacts them. Don't store raw text anywhere else.
- **Edits need absolute paths.** Resolve relative paths against the working directory in effect at that point in the session.
- **Token usage must not double count.** Check whether the agent logs cumulative totals or per-call deltas, whether a response is split across lines, and whether cached tokens are a subset of input. `TokenUsage` fields are disjoint.
- **Missing data stays missing.** Unknown exit code → `null`. No usage at all → don't call `addUsage` (cost becomes unknown, not $0).

### 3. Fixtures and tests

- Add anonymized fixtures under `test/fixtures/home/<agent data dir>/`, mirroring the real layout, with fake prompts, paths and code but the real structure.
- Include at least one corrupted line and one unknown event type.
- Add cases to `test/adapters.test.ts` covering sessions, models, token usage, prompts (with a secret that must be redacted), edits with line counts, commands with exit codes, warnings and skipped events.
- Add an end-to-end case to `test/attribute.test.ts` using a session builder in `test/helpers.ts`, so a commit made with your agent gets the right attribution.

### 4. Document it

Add a row to the "Supported agents" table in `README.md` with verified or unverified status and the versions you observed.

## Other changes

- **Receipt format.** `Receipt` in `src/types.ts` is versioned by `schemaVersion`. Adding optional fields is fine. Renaming or removing a field needs a version bump and a reader that handles both versions.
- **Pricing.** Edit `src/pricing.json`, bump `version`, and cite the source. Mark any per-token-type price you derived instead of read from a price list in `derived`.
- **Hooks.** Anything that runs inside a git hook must be fast, must stay silent, and must never exit non-zero. Log to `~/.rcpt/logs/` instead.

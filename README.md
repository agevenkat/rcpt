# rcpt

**Receipts for AI-written code.** For every commit, rcpt records which coding agent and model did the work, which lines it wrote, whether tests ran, and roughly what it cost. Receipts live in your git repository. Nothing leaves your machine.

<!-- demo GIF: `rcpt init` → commit with Claude Code → `rcpt receipt HEAD` -->
![rcpt demo](docs/demo.gif)

```text
🧾 rcpt receipt  3f2a9c1e8b  Add rate limiting to the API client
AI-assisted   yes  (link confidence: high)
  claude-code 2.1.316 · claude-opus-5-5 · high (line-match, file-match)
Prompt        “Add rate limiting with exponential backoff to the API client”

Files                                  AI lines / added   confidence
  src/api/client.ts                              38 / 42   high
  src/api/client.test.ts                         27 / 27   high
  Total                                          65 / 69   94% AI

Tests         passed  (npm test)
Est. cost     $0.41  (medium confidence, list prices 2026-11-02)
Human edits   yes, AI-touched files also contain non-AI lines
```

## Quick start

```sh
npx rcpt init          # in your repo: installs a post-commit hook and creates .rcpt.json
# …work with Claude Code, Codex CLI or Gemini CLI and commit as usual…
npx rcpt receipt HEAD  # see the receipt for your last commit
```

Other commands:

| Command | What it does |
|---|---|
| `rcpt doctor` | Which agents are installed, how many sessions were found, any parse warnings |
| `rcpt receipt [rev] [--json]` | Show a commit's receipt |
| `rcpt backfill --since 30d` | Create receipts for past commits from agent logs still on disk |
| `rcpt report --since 30d --out report.html` | Self-contained HTML report (or `--json`): AI share, spend per agent, tests, rewrite rate |
| `rcpt badge` | Markdown for a README badge with your AI-written share |
| `rcpt sync [remote]` | Fetch teammates' receipts and push yours |
| `rcpt attribute [rev]` | Compute a receipt without saving it |
| `rcpt uninstall [--purge-notes]` | Remove everything `init` added |

Requires Node 22.15+ and git 2.30+.

## Supported agents

| Agent | Status | Where rcpt reads logs |
|---|---|---|
| Claude Code | ✅ verified (2.1.284 – 2.1.316) | `~/.claude/projects/` (or `$CLAUDE_CONFIG_DIR`) |
| Codex CLI | ✅ verified (0.95 – 0.163) | `~/.codex/sessions/`, `archived_sessions/` (or `$CODEX_HOME`), including `.jsonl.zst` |
| Gemini CLI | ⚠️ partly verified (0.66.0): sessions, prompts, model replies and token usage checked; file-edit and shell tool calls still follow the documented format | `~/.gemini/tmp/<project>/chats/` (`.jsonl`; older `.json` too) |
| Cursor, Copilot | not yet. Adding one is a single file, see [CONTRIBUTING.md](CONTRIBUTING.md) | |

Log formats are undocumented and change between releases. What each version actually writes is recorded in [docs/log-formats.md](docs/log-formats.md). Parsers skip unknown events instead of failing. `rcpt doctor -v` shows anything they skipped.

## Privacy

- **Nothing is uploaded.** rcpt has no server, no account and no telemetry. It reads agent logs in your home directory and writes git notes in your repository.
- **What a receipt stores** (as a git note under `refs/notes/rcpt`): agent names and versions, model names, per-file line counts, the line numbers of AI-matched lines, test command and result, token-based cost estimate, and a **short redacted summary of the prompt**. It never stores code.
- **Redaction runs before anything is stored.** API keys (Anthropic, OpenAI, GitHub, GitLab, Slack, AWS, Google, Stripe, npm), JWTs, bearer tokens, private keys, credentials in URLs, email addresses and `.env`-style `SECRET=…` values are replaced with `[REDACTED:…]`.
- **Full prompts are opt-in** (`"storeFullPrompts": true` in `.rcpt.json`). They're redacted too.
- **Sharing is opt-in.** `rcpt init` asks before changing your git config. If you agree, it adds a fetch refspec for `refs/notes/rcpt*` and a `pre-push` hook that pushes `refs/notes/rcpt` in the background. It never changes what a plain `git push` pushes. Notes reach your remote only when you push.
- The only network request rcpt can trigger is that `git push`/`fetch` of notes to your own remote. The GitHub Action runs in your CI with your token.

## How attribution works

When you commit, the post-commit hook starts rcpt in the background (the commit itself is slowed by about 10 ms). rcpt then:

1. **Finds candidate sessions:** agent sessions in this repository (by working directory, subdirectory, linked worktree, or Gemini project hash) that were active between the parent commit and this commit, plus a 5-minute grace period after it.
2. **Matches lines.** Each line the agent wrote (Write/Edit tools, `apply_patch`, Codex file changes, and shell edits that Claude Code logs) is normalized (whitespace collapsed) and hashed. Added lines in the commit diff are matched against those hashes, each AI line counted at most once. Matched lines are AI-written. Unmatched lines are human-written, **unless** an agent ran file-writing shell commands in that window (scripts, `sed -i`, redirects…). Then rcpt can't tell who wrote them, so it reports them as *unknown* rather than guessing.
3. **Assigns confidence to every link:**
   - **high**: the agent's lines appear in the commit
   - **medium**: the agent edited a committed file but its lines didn't survive, or the agent ran the `git commit` itself
   - **low**: the agent was only active in the repository during the window. Low links don't make a commit AI-assisted.
4. **Detects tests:** the last test-runner command (npm/pnpm/yarn/bun test, vitest, jest, pytest, go test, cargo test, gradle, rspec, dotnet test…, extendable with `testPatterns`) that a session ran in the repository, and its exit code.
5. **Estimates cost** from the token usage the agent logged in the window, priced with `src/pricing.json` (versioned; override per model in `.rcpt.json`). Missing usage gives an *unknown* cost, never $0. Subscription plans aren't billed per token, so read it as the API-equivalent cost.

Lockfiles and build output are left out of every line count (add more globs under `ignore`). Merge commits aren't attributed.

**Known limits.** If you split one agent session across several commits, edits made before the previous commit count only toward that one. Agents prune old logs (Claude Code keeps about 30 days by default), so `backfill` can't attribute older commits. A commit without a receipt is shown as *no receipt*, never as human-written.

## Configuration (`.rcpt.json`)

```json
{
  "graceMinutes": 5,
  "rootLookbackDays": 7,
  "testPatterns": ["^make e2e\\b"],
  "storeFullPrompts": false,
  "trailer": false,
  "ignore": ["**/generated/**"],
  "pricing": { "my-internal-model": { "input": 1, "output": 4, "cacheRead": 0.1, "cacheWrite": 1.25, "cacheWrite1h": 2 } }
}
```

`"trailer": true` (then run `rcpt init` again) adds `AI-Assisted: claude-code/claude-opus-5-5; ai-lines=42/50` to commit messages. The trailer has to be computed before the commit exists, so it runs synchronously and adds roughly a second per commit. That's why it's off by default. Set `RCPT_DISABLE=1` to skip rcpt for a single command. Errors go to `~/.rcpt/logs/rcpt.log` and never to your terminal.

## Pull request summaries (GitHub Action)

```yaml
# .github/workflows/rcpt.yml
on: pull_request
permissions:
  contents: read
  pull-requests: write
jobs:
  rcpt:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: agevenkat/rcpt/action@v1
```

The action posts one comment per PR and updates it on every push:
> 🧾 rcpt: 3 of 4 commits AI-assisted · claude-code, codex · 68% of added lines · tests ✅ · est. $1.12 · 1 without receipt

On pull requests from forks the token is read-only, so the summary goes to the job summary instead of a comment.

## Badge

```sh
npx rcpt badge --since 90d
# ![AI-written lines: 68%](https://img.shields.io/badge/AI--written%20lines-68%25-2a78d6)
```

## License

MIT

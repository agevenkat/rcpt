# Agent session log formats

Agent session logs are undocumented and change between releases. This file records what we
**observed**, when, and on which versions. It is structure only: key names, types and counts, never
prompt text, code or real paths. Update it whenever an adapter changes.

| Agent | Status | Versions observed | Observed on | Sample size |
|---|---|---|---|---|
| Claude Code | **verified** | 2.1.284 – 2.1.316 | 2026-11-02, macOS | 827 files / 174,644 lines (30 days) |
| Codex CLI | **verified** | 0.95.0-alpha.7 – 0.163.0-alpha.10.2 | 2026-11-02, macOS | 28 rollouts / 16k+ lines |
| Gemini CLI | **unverified** | none (not installed) | — | fixture only, from documented format |

General rules for every adapter:

- Unknown fields are ignored. Unknown event types are counted in `skippedEvents` (shown by `rcpt doctor -v`).
- Unparseable lines become warnings. `parseSession` never throws.
- Prompts and commands pass through `src/util/redact.ts` before they enter an `AgentSession`.
- File edits are kept as hashes of normalized, non-blank lines, never as code text.

---

## Claude Code

**Location:** `$CLAUDE_CONFIG_DIR/projects` or `~/.claude/projects/`

```
projects/<cwd with "/" and "." replaced by "-">/<sessionId>.jsonl          one session
projects/<…>/<sessionId>/subagents/agent-<agentId>.jsonl                  subagent (Task) logs
```

The rcpt adapter merges subagent logs into their parent session: their edits, commands and usage
count toward it, but their prompts don't (they come from the parent agent, not a human).

**Format:** JSONL, one event per line, with a top-level `type`. rcpt uses `user` and `assistant`.
About 25 other types are skipped: `attachment`, `api-request`, `api-request-blob`, `mode`,
`permission-mode`, `ai-title`, `last-prompt`, `system`, `queue-operation`, `file-history-snapshot`,
`file-history-delta`, `pr-link`, `cost-state`, and others.

Fields common to `user`/`assistant` events: `uuid`, `parentUuid`, `sessionId`, `timestamp`
(ISO 8601), `cwd`, `version` (CLI version), `gitBranch`, `isSidechain` (true in subagent logs),
`message`.

### assistant
- `message.model` (string). `"<synthetic>"` marks locally generated messages with no API call.
- `message.id`. **One API response is split across several lines** (one per content block), and
  every line repeats the full `message.usage`. Usage must be deduplicated by `message.id`. In a
  sample file, 8 message ids were spread over 15 lines.
- `message.usage`: `input_tokens`, `output_tokens`, `cache_read_input_tokens`,
  `cache_creation_input_tokens` (all numbers; `input_tokens` excludes cache reads and writes),
  plus `cache_creation.{ephemeral_5m,ephemeral_1h}_input_tokens`, `iterations[]`, `service_tier`,
  `speed`, `server_tool_use`, which rcpt doesn't use.
- `message.content[]`: blocks of type `text`, `thinking`, `tool_use` (`id`, `name`, `input`).

Tool names observed (30 days): Bash 11,678 · Write 1,020 · Read 876 · WebFetch 597 · WebSearch 318 ·
Edit 245 · Agent 236 · others (plus `mcp__*`). `MultiEdit` and `NotebookEdit` weren't observed.
rcpt still handles `MultiEdit` from its input shape.

### user
A `user` event is either a **prompt** or **tool results**.

- Tool results: `message.content[]` contains `{type: "tool_result", tool_use_id, is_error?, content}`.
  The event-level `toolUseResult` holds structured detail:
  - Write/Edit: `filePath`, `type` (`"create"` | `"update"`), `content` (on create),
    `structuredPatch[]` = `{oldStart, oldLines, newStart, newLines, lines[]}` where each line is
    prefixed `" "`, `"+"` or `"-"`. Also `oldString`, `newString`, `originalFile`, `userModified`.
  - Bash: `stdout`, `stderr`, `interrupted`, `isImage`, `noOutputExpected`. **There's no
    numeric exit code field.** A non-zero exit shows up as `is_error: true` with content starting
    `"Exit code N"` (286 of 494 errors). Other errors (185 "other", 23 `<tool_use_error>`) give
    exit code `null`.
  - Bash `bashEditDiff`: files changed by a shell command (e.g. `sed -i`).
    `files[] = {filePath, created?, deleted?, hunks[]}` with hunk `lines[]` as above, plus
    `changedFiles[]`, `moreFiles`, `unavailable?`. rcpt records these as edits with `tool: "bash"`.
  - `toolUseResult` can also be a string or an array (image/text results).
- Prompts: `message.content` is a string (or an array of `text` blocks). rcpt treats an event as a
  human prompt when `isMeta !== true`, `isSidechain !== true` and `origin.kind` is absent or
  `"human"`. Observed `origin.kind` values: `human`, `task-notification`, `coordinator`, `peer`,
  `auto-continuation`. Observed `promptSource` values: `typed`, `queued`, `system`, `sdk`,
  `suggestion_accepted`.

---

## Codex CLI

**Location:** `$CODEX_HOME` or `~/.codex/`

```
sessions/YYYY/MM/DD/rollout-<YYYY-MM-DDTHH-MM-SS>-<uuid>.jsonl        current sessions
sessions/YYYY/MM/DD/rollout-…-<uuid>.jsonl.zst                        older sessions, zstd-compressed
archived_sessions/…                                                   archived (also .zst)
```

Most older rollouts are **zstd-compressed**. rcpt decompresses them with Node's built-in
`zlib.zstdDecompressSync` (Node ≥ 22.15). On older Node versions those files are reported as
warnings and skipped.

Other files in `~/.codex` (`history.jsonl`, `session_index.jsonl`, `*.sqlite`, `auth.json`) are
**not read**. `auth.json` holds credentials.

**Format:** JSONL with lines shaped `{timestamp, type, payload, ordinal?}`.
`payload.type` subdivides `event_msg` and `response_item`.

| Line | Used for |
|---|---|
| `session_meta` | `payload.id`, `cwd`, `cli_version`, `source` (`"cli"`, `"vscode"`, or `{subagent:…}`), `originator` |
| `turn_context` | `payload.model` (current model for following usage), `cwd` |
| `event_msg/token_count` | `payload.info.total_token_usage` and `last_token_usage`: `{input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens, total_tokens}`; `info` may be `null` |
| `event_msg/item_completed` | `payload.item` with `type` = `UserMessage`, `CommandExecution`, `FileChange` (used); `AgentMessage`, `Reasoning`, `McpToolCall`, `WebSearch`, `ContextCompaction`, `Extension`, `DynamicToolCall` (skipped) |
| `response_item/function_call` | `name` = `exec_command` (`arguments` JSON: `cmd`, `workdir`, …), `apply_patch`, `update_plan`, `write_stdin`, … |
| `response_item/custom_tool_call` | `name` = `apply_patch` (raw `*** Begin Patch` text in `input`) or `exec` (JS code, newer CLIs) |
| `response_item/*_output` | `call_id`, `output` (string or array of `{type:"input_text", text}`) |
| `token_usage_record`, `compacted`, `world_state`, `response_item/message`, `response_item/reasoning`, `thread_settings_applied`, `task_started`/`task_complete`, `turn_aborted` | skipped |

### Token usage (checked against all 28 local rollouts)
- `total_token_usage` is cumulative and never decreased. **304 `token_count` events repeated the
  previous total unchanged**, so summing `last_token_usage` naively over-counts. rcpt sums the
  deltas of `total_token_usage` and attributes each delta to the model from the latest
  `turn_context`. The result matches the raw final totals exactly (256,191,892 tokens).
- `cached_input_tokens ≤ input_tokens` in every event: cached is a **subset** of input. rcpt
  stores `input = input_tokens − cached_input_tokens`, `cacheRead = cached_input_tokens`.
- `reasoning_output_tokens ≤ output_tokens` in every event: reasoning is included in output.

### Two generations of tool logging
| CLI versions | Commands | File edits |
|---|---|---|
| ≤ 0.116 | `function_call` `exec_command`; exit code parsed from output text `"Process exited with code N"` | `apply_patch` calls (paths relative to turn `cwd`); failed patches have `metadata.exit_code ≠ 0` in output |
| 0.118 – 0.128 | both of the above **and** partial `CommandExecution` items | `apply_patch`, plus `FileChange` items from 0.128 |
| ≥ 0.150 | `CommandExecution` items only (`command[]` like `["/bin/zsh","-lc","…"]`, `exit_code`, `cwd`, `status`); the model drives them through `exec` JS calls | `FileChange` items only: `changes` = map of absolute path → `{type: "add", content}` / `{type: "delete", content}` / `{type: "update", unified_diff, move_path}` |

Where both generations appear, item `id` equals the call's `call_id` (verified: 0.118 had 11/11
matched, 0.120 had 35/35, 0.128 had 64/64). rcpt takes the union keyed by id, and the item wins, so
nothing is double counted. In every file containing `FileChange` items, every `apply_patch` call had
a matching `FileChange`.

### Prompts
`event_msg/item_completed` with `item.type = "UserMessage"`: `content[] = {type: "text", text,
text_elements}` (also `image`/`local_image`). `response_item/message` with `role: "user"` is **not**
used, because it also carries injected context (environment, AGENTS.md).

### Other observations
- Models seen: `gpt-5.2`, `gpt-5.2-codex`, `gpt-5.3-codex`, `gpt-5.4`, `gpt-5.6-terra`,
  `gpt-6-luna`, `codex-auto-review` (the guardian subagent), and non-OpenAI providers via
  `model_provider` (`gemma4`, `qwen3.5:cloud`).
- On this machine `codex --version` fails (missing native binary), so the version always comes from
  `session_meta.payload.cli_version`.

---

## Gemini CLI — UNVERIFIED

Gemini CLI isn't installed on the development machine. `~/.gemini/` exists but contains only
Antigravity IDE data (`antigravity*/`, `config/`). The adapter follows Gemini CLI's documented
chat-recording format and is marked `verified: false` until it's checked against real logs.

**Expected location:** `~/.gemini/tmp/<projectHash>/chats/session-<timestamp>-<shortId>.json`,
where `projectHash` is the SHA-256 of the project root path.

**Expected format:** a single JSON document (not JSONL), rewritten as the session progresses:

```jsonc
{
  "sessionId": "…", "projectHash": "…", "startTime": "ISO", "lastUpdated": "ISO",
  "messages": [
    { "id", "timestamp", "type": "user" | "gemini" | "info" | "error" | "warning",
      "content": "string or Part[]",
      "model": "…",                                   // gemini messages
      "tokens": { "input", "output", "cached", "thoughts", "tool", "total" },
      "toolCalls": [ { "id", "name", "args", "result", "status", "timestamp", "resultDisplay" } ] }
  ]
}
```

Adapter assumptions, all to be checked once real logs are available:
- No `cwd` field. rcpt records `projectHash`, and attribution (Phase 2) matches it by hashing
  candidate repo roots.
- No CLI version field, so `agentVersion` is `null`.
- `tokens.input` includes `tokens.cached` (as in Gemini API usage metadata); `thoughts` are billed
  as output; `tool` tokens are counted as input.
- Edits: `write_file` (`file_path`, `content`) and `replace` (`file_path`, `old_string`,
  `new_string`). `resultDisplay.fileDiff` (unified diff) is preferred when present.
  Non-`success` status means the edit isn't counted.
- Commands: `run_shell_command` (`command`, `directory`); exit code from `"Exit Code: N"` in the
  result, otherwise 0 on `success` and `null` on anything else.
- A truncated or invalid file produces a warning and no session.

To verify: install Gemini CLI, run one session in a git repo, run `rcpt doctor -v`, and compare a
structural scan of the file against this section.

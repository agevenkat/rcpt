// Stable data model for rcpt. Bump RECEIPT_SCHEMA_VERSION on any breaking change to Receipt.

export const RECEIPT_SCHEMA_VERSION = 1;

export type AgentId = 'claude-code' | 'codex' | 'gemini-cli' | (string & {});

export type Confidence = 'high' | 'medium' | 'low';

/**
 * Token counts are disjoint: `input` excludes cached tokens. Cache writes are split by TTL because
 * Anthropic prices 1-hour writes (2x input) differently from 5-minute writes (1.25x input).
 */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
}

export interface UsageEvent {
  timestamp: string;
  model: string;
  usage: TokenUsage;
}

export interface PromptRecord {
  timestamp: string;
  /** Redacted text. Never stored unredacted. */
  text: string;
}

export interface FileEdit {
  /** Absolute path when the log provides or lets us resolve one. */
  path: string;
  timestamp: string;
  kind: 'create' | 'update' | 'delete';
  /** Hashes of normalized non-blank lines (see util/lines.ts). No code text is kept. */
  addedLineHashes: string[];
  removedLineHashes: string[];
  linesAdded: number;
  linesRemoved: number;
  /** Tool that produced the edit, e.g. "Edit", "apply_patch", "bash". */
  tool: string;
}

export interface CommandRecord {
  timestamp: string;
  /** Redacted command line. */
  command: string;
  cwd: string | null;
  /** null when the log doesn't tell us (interrupted, still running, unknown format). */
  exitCode: number | null;
  isTest: boolean;
}

export interface AgentSession {
  id: string;
  agent: AgentId;
  agentVersion: string | null;
  models: string[];
  /** Working directory the session started in; null if the log doesn't record it. */
  cwd: string | null;
  /** Agent-specific project identifier when cwd is unavailable (e.g. Gemini CLI project hash). */
  projectHash?: string;
  startedAt: string;
  endedAt: string;
  prompts: PromptRecord[];
  fileEdits: FileEdit[];
  commandsRun: CommandRecord[];
  /** Per model. null means the log had no usage data (cost must then be null, never 0). */
  tokenUsage: Record<string, TokenUsage> | null;
  /** The same usage over time, so cost can be split across commits. */
  usageEvents: UsageEvent[];
  sourcePaths: string[];
}

/**
 * Why a session is linked to a commit. line-match: its edits match added lines (high). file-match: it edited
 * a committed file (medium). ran-commit: it ran the `git commit` (medium). time-window: it was active in
 * this repo during the commit window, nothing more (low).
 */
export type Evidence = 'line-match' | 'file-match' | 'ran-commit' | 'time-window';

export type TestStatus = 'none' | 'passed' | 'failed' | 'unknown';

export interface FileAttribution {
  /** Repo-relative, forward slashes. */
  path: string;
  /** Added lines matched to agent output; null when an agent may have written the file in a way its log doesn't show. */
  aiLinesAdded: number | null;
  /** Non-blank lines this commit added to the file. */
  totalLinesAdded: number;
  /**
   * high: line-level evidence (or no agent activity at all); medium: the agent edited the file but its lines
   * didn't survive, or an agent was active but logged no edit to it; low: an agent ran file-writing shell
   * commands, so its share can't be determined.
   */
  confidence: Confidence;
  /** Line numbers (in this commit's version of the file) matched to agent output, as ranges "3-5,9". */
  aiLines?: string;
}

export interface Receipt {
  schemaVersion: typeof RECEIPT_SCHEMA_VERSION;
  commitSha: string;
  /** true when at least one session is linked with medium or high confidence. */
  aiAssisted: boolean;
  /** Strongest session link; null when no session was found. */
  confidence: Confidence | null;
  sessions: {
    id: string;
    agent: AgentId;
    agentVersion: string | null;
    models: string[];
    confidence: Confidence;
    evidence: Evidence[];
    /** Added lines in this commit matched to this session's edits. */
    aiLinesAdded: number;
    /** This session's share of the cost; null for time-window-only links or missing usage. */
    estimatedCostUsd: number | null;
  }[];
  /** Redacted, truncated first prompt from the linked sessions in this commit's window. */
  promptSummary: string | null;
  /** Full redacted prompts; only present when the user opts in (storeFullPrompts). */
  prompts?: string[];
  filesAttributed: FileAttribution[];
  /**
   * unknownLines: added lines in files whose aiLinesAdded is null. ignoredLines: lines in generated files
   * (lockfiles, build output, config "ignore"), excluded from every other count.
   */
  totals: { aiLinesAdded: number; totalLinesAdded: number; unknownLines: number; ignoredLines: number };
  testsRun: { status: TestStatus; command: string | null };
  estimatedCostUsd: {
    /** null when token usage is missing. Never 0 as a stand-in for unknown. */
    amount: number | null;
    pricingVersion: string;
    confidence: Confidence;
    unpricedModels: string[];
  };
  /** true: AI-touched files also contain non-AI lines; false: they don't; null: no AI-touched files. */
  humanEditedAfterAi: boolean | null;
  /** Merge commits aren't attributed (their lines came from other commits). */
  isMerge: boolean;
  createdAt: string;
  generator: { name: 'rcpt'; version: string };
}

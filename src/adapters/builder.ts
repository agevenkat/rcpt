import type { AgentId, AgentSession, FileEdit, TokenUsage, UsageEvent } from '../types.js';
import type { ParseResult, ParseWarning } from './types.js';
import { countNonBlank, hashLines, type LineDelta } from '../util/lines.js';
import { redact } from '../util/redact.js';
import { isTestCommand } from '../util/test-commands.js';

/** Accumulates normalized session data while an adapter walks a log. */
export class SessionBuilder {
  id: string;
  agentVersion: string | null = null;
  cwd: string | null = null;
  projectHash?: string;
  private models = new Set<string>();
  private minT = Infinity;
  private maxT = -Infinity;
  private usage: Record<string, TokenUsage> = {};
  private hasUsage = false;
  private usageEvents: UsageEvent[] = [];
  readonly warnings: ParseWarning[] = [];
  readonly skipped: Record<string, number> = {};
  readonly session: Omit<AgentSession, 'id' | 'agentVersion' | 'models' | 'cwd' | 'startedAt' | 'endedAt' | 'tokenUsage' | 'usageEvents'>;

  constructor(
    readonly agent: AgentId,
    id: string,
    sourcePath: string,
  ) {
    this.id = id;
    this.session = { agent, prompts: [], fileEdits: [], commandsRun: [], sourcePaths: [sourcePath] };
  }

  skip(type: string) {
    this.skipped[type] = (this.skipped[type] ?? 0) + 1;
  }

  seen(ts: unknown) {
    if (typeof ts !== 'string' && typeof ts !== 'number') return;
    const t = new Date(ts).getTime();
    if (!Number.isFinite(t)) return;
    if (t < this.minT) this.minT = t;
    if (t > this.maxT) this.maxT = t;
  }

  model(m: string | undefined) {
    if (m && !m.startsWith('<')) this.models.add(m);
  }

  addUsage(model: string, u: Partial<TokenUsage>, timestamp: string) {
    const key = model || 'unknown';
    if (!this.usage[key]) this.usage[key] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 };
    const cur = this.usage[key];
    cur.input += u.input ?? 0;
    cur.output += u.output ?? 0;
    cur.cacheRead += u.cacheRead ?? 0;
    cur.cacheWrite += u.cacheWrite ?? 0;
    cur.cacheWrite1h += u.cacheWrite1h ?? 0;
    this.hasUsage = true;
    this.usageEvents.push({
      timestamp,
      model: key,
      usage: { input: u.input ?? 0, output: u.output ?? 0, cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0, cacheWrite1h: u.cacheWrite1h ?? 0 },
    });
  }

  prompt(timestamp: string, text: string) {
    if (text.trim()) this.session.prompts.push({ timestamp, text: redact(text) });
  }

  edit(path: string, timestamp: string, kind: FileEdit['kind'], delta: LineDelta, tool: string) {
    this.session.fileEdits.push({
      path,
      timestamp,
      kind,
      addedLineHashes: hashLines(delta.added),
      removedLineHashes: hashLines(delta.removed),
      linesAdded: countNonBlank(delta.added),
      linesRemoved: countNonBlank(delta.removed),
      tool,
    });
  }

  command(timestamp: string, command: string, cwd: string | null, exitCode: number | null) {
    this.session.commandsRun.push({
      timestamp,
      command: redact(command),
      cwd,
      exitCode,
      isTest: isTestCommand(command),
    });
  }

  result(): ParseResult {
    if (this.minT === Infinity) {
      this.warnings.push({ path: this.session.sourcePaths[0]!, message: 'no timestamped events; not a usable session' });
      return { session: null, warnings: this.warnings, skippedEvents: this.skipped };
    }
    const iso = (t: number) => new Date(t).toISOString();
    return {
      session: {
        ...this.session,
        id: this.id,
        agentVersion: this.agentVersion,
        models: [...this.models],
        cwd: this.cwd,
        ...(this.projectHash ? { projectHash: this.projectHash } : {}),
        startedAt: iso(this.minT),
        endedAt: iso(this.maxT),
        tokenUsage: this.hasUsage ? this.usage : null,
        usageEvents: this.usageEvents.sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
      },
      warnings: this.warnings,
      skippedEvents: this.skipped,
    };
  }
}

export function failed(path: string, err: unknown): ParseResult {
  return {
    session: null,
    warnings: [{ path, message: err instanceof Error ? err.message : String(err) }],
    skippedEvents: {},
  };
}

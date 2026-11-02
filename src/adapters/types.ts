import type { AgentId, AgentSession } from '../types.js';

export interface AdapterOptions {
  /** Home directory to search. Defaults to os.homedir(); tests point this at fixtures. */
  home: string;
  env?: NodeJS.ProcessEnv;
}

export interface DetectResult {
  detected: boolean;
  dataDir: string;
}

export interface SessionRef {
  path: string;
  mtime: Date;
}

export interface ParseWarning {
  path: string;
  line?: number;
  message: string;
}

export interface ParseResult {
  /** null when the file couldn't be used at all (see warnings). */
  session: AgentSession | null;
  warnings: ParseWarning[];
  /** Event types we saw but don't use, with counts. Unknown types land here, not in errors. */
  skippedEvents: Record<string, number>;
}

export interface AgentAdapter {
  id: AgentId;
  displayName: string;
  /** true when the parser was checked against real logs on a developer machine (see docs/log-formats.md). */
  verified: boolean;
  detect(): Promise<DetectResult>;
  /** Cheap listing; `since` filters on file mtime. */
  listSessions(since?: Date): Promise<SessionRef[]>;
  /** Never throws. Failures come back as warnings with session = null. */
  parseSession(path: string): Promise<ParseResult>;
}

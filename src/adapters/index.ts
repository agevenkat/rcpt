import os from 'node:os';
import type { AgentAdapter, AdapterOptions } from './types.js';
import { claudeCodeAdapter } from './claude-code.js';
import { codexAdapter } from './codex.js';
import { geminiCliAdapter } from './gemini-cli.js';

/** To add an agent: write src/adapters/<agent>.ts implementing AgentAdapter, then add it here. */
const FACTORIES: ((o: AdapterOptions) => AgentAdapter)[] = [claudeCodeAdapter, codexAdapter, geminiCliAdapter];

export function createAdapters(opts: Partial<AdapterOptions> = {}): AgentAdapter[] {
  const o: AdapterOptions = { home: opts.home ?? os.homedir(), env: opts.env ?? process.env };
  return FACTORIES.map((f) => f(o));
}

export type { AgentAdapter } from './types.js';

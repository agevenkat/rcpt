import type { AgentAdapter } from './adapters/types.js';
import { zstdSupported } from './util/read.js';

export interface AgentReport {
  agent: string;
  displayName: string;
  verified: boolean;
  detected: boolean;
  dataDir: string;
  totalSessions: number;
  recentSessions: number;
  parsed: number;
  unusable: number;
  versions: string[];
  models: string[];
  fileEdits: number;
  commands: number;
  testCommands: number;
  withTokenUsage: number;
  warnings: { message: string; count: number }[];
  skippedEvents: Record<string, number>;
}

export async function runDoctor(adapters: AgentAdapter[], since: Date): Promise<AgentReport[]> {
  const reports: AgentReport[] = [];
  for (const a of adapters) {
    const { detected, dataDir } = await a.detect();
    const r: AgentReport = {
      agent: a.id, displayName: a.displayName, verified: a.verified, detected, dataDir,
      totalSessions: 0, recentSessions: 0, parsed: 0, unusable: 0, versions: [], models: [],
      fileEdits: 0, commands: 0, testCommands: 0, withTokenUsage: 0, warnings: [], skippedEvents: {},
    };
    reports.push(r);
    if (!detected) continue;

    r.totalSessions = (await a.listSessions()).length;
    const recent = await a.listSessions(since);
    r.recentSessions = recent.length;
    const versions = new Set<string>();
    const models = new Set<string>();
    const warn = new Map<string, number>();
    for (const ref of recent) {
      const res = await a.parseSession(ref.path);
      for (const w of res.warnings) warn.set(w.message, (warn.get(w.message) ?? 0) + 1);
      for (const [k, n] of Object.entries(res.skippedEvents)) r.skippedEvents[k] = (r.skippedEvents[k] ?? 0) + n;
      const s = res.session;
      if (!s) {
        r.unusable++;
        continue;
      }
      r.parsed++;
      if (s.agentVersion) versions.add(s.agentVersion);
      for (const m of s.models) models.add(m);
      r.fileEdits += s.fileEdits.length;
      r.commands += s.commandsRun.length;
      r.testCommands += s.commandsRun.filter((c) => c.isTest).length;
      if (s.tokenUsage) r.withTokenUsage++;
    }
    r.versions = [...versions].sort();
    r.models = [...models].sort();
    r.warnings = [...warn].map(([message, count]) => ({ message, count })).sort((x, y) => y.count - x.count);
  }
  return reports;
}

export function formatDoctor(reports: AgentReport[], sinceLabel: string, verbose = false): string {
  const out: string[] = ['rcpt doctor', ''];
  for (const r of reports) {
    const status = r.verified ? 'verified' : 'unverified';
    if (!r.detected) {
      out.push(`✗ ${r.displayName} (${status}): not detected — looked in ${r.dataDir}`, '');
      continue;
    }
    out.push(`✓ ${r.displayName} (${status}): ${r.dataDir}`);
    out.push(`    sessions: ${r.totalSessions} total, ${r.recentSessions} in last ${sinceLabel}`);
    out.push(`    parsed:   ${r.parsed} ok, ${r.unusable} unusable, ${r.withTokenUsage} with token usage`);
    if (r.versions.length) out.push(`    versions: ${r.versions.join(', ')}`);
    if (r.models.length) out.push(`    models:   ${r.models.join(', ')}`);
    out.push(`    activity: ${r.fileEdits} file edits, ${r.commands} commands (${r.testCommands} test runs)`);
    const nWarn = r.warnings.reduce((n, w) => n + w.count, 0);
    if (nWarn) {
      out.push(`    warnings: ${nWarn}`);
      for (const w of r.warnings.slice(0, verbose ? Infinity : 3)) out.push(`      ${w.count}× ${w.message}`);
    }
    if (verbose) {
      const skipped = Object.entries(r.skippedEvents).sort((a, b) => b[1] - a[1]);
      if (skipped.length) out.push(`    ignored event types: ${skipped.map(([k, n]) => `${k}(${n})`).join(', ')}`);
    }
    out.push('');
  }
  if (!zstdSupported) out.push(`note: Node ${process.version} can't read zstd-compressed Codex logs; Node >= 22.15 can.`);
  return out.join('\n');
}

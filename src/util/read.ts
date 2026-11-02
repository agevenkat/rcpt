import fs from 'node:fs/promises';
import zlib from 'node:zlib';
import path from 'node:path';
import type { ParseWarning } from '../adapters/types.js';

type ZstdDecompress = (buf: Buffer) => Buffer;
const zstdDecompressSync = (zlib as unknown as { zstdDecompressSync?: ZstdDecompress }).zstdDecompressSync;

export const zstdSupported = typeof zstdDecompressSync === 'function';

export class UnsupportedCompressionError extends Error {}

/** Read a log file as UTF-8, transparently decompressing .zst when Node supports it (>=22.15). */
export async function readLogText(file: string): Promise<string> {
  const buf = await fs.readFile(file);
  if (file.endsWith('.zst')) {
    if (!zstdDecompressSync) {
      throw new UnsupportedCompressionError(
        `zstd-compressed log needs Node >= 22.15 (running ${process.version})`,
      );
    }
    return zstdDecompressSync(buf).toString('utf8');
  }
  return buf.toString('utf8');
}

/** Parse JSONL defensively: bad lines become warnings, never exceptions. */
export function parseJsonl(text: string, file: string, warnings: ParseWarning[]): unknown[] {
  const out: unknown[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      warnings.push({ path: file, line: i + 1, message: 'skipped unparseable line' });
    }
  }
  return out;
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Recursively list files under dir matching a predicate. Missing dirs yield []. */
export async function walkFiles(
  dir: string,
  match: (name: string) => boolean,
  maxDepth = 6,
): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string, depth: number) {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && depth < maxDepth) await walk(p, depth + 1);
      else if (e.isFile() && match(e.name)) out.push(p);
    }
  }
  await walk(dir, 0);
  return out;
}

export async function withMtimes(files: string[], since?: Date) {
  const refs = await Promise.all(
    files.map(async (p) => {
      try {
        return { path: p, mtime: (await fs.stat(p)).mtime };
      } catch {
        return null;
      }
    }),
  );
  return refs
    .filter((r): r is { path: string; mtime: Date } => r !== null)
    .filter((r) => !since || r.mtime >= since)
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}

/** Small helpers for poking at untyped JSON without crashing. */
export const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
export const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
export const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

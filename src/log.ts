import fs from 'node:fs';
import path from 'node:path';
import { rcptHome } from './paths.js';

/** Append an error to ~/.rcpt/logs/rcpt.log. Never throws: logging must not break a git workflow. */
export function logError(message: string, err?: unknown): void {
  try {
    const dir = path.join(rcptHome(), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const detail = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : err === undefined ? '' : String(err);
    fs.appendFileSync(path.join(dir, 'rcpt.log'), `${new Date().toISOString()} ${message}${detail ? `\n${detail}` : ''}\n`);
  } catch {
    /* nowhere left to report */
  }
}

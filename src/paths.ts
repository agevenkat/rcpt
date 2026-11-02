import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** rcpt's own data directory (logs, user config). */
export function rcptHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.RCPT_HOME || path.join(os.homedir(), '.rcpt');
}

/**
 * Canonical form for comparing paths across agents, git and OSes: symlinks resolved (macOS /tmp ->
 * /private/tmp) even for files that no longer exist, forward slashes, and case-folded on Windows.
 */
export function normPath(p: string, platform: NodeJS.Platform = process.platform): string {
  let abs = path.resolve(p);
  const tail: string[] = [];
  // Resolve the deepest existing ancestor so deleted or not-yet-created files still normalize.
  for (;;) {
    try {
      abs = path.join(fs.realpathSync.native(abs), ...tail.reverse());
      break;
    } catch {
      const parent = path.dirname(abs);
      if (parent === abs) {
        abs = path.join(abs, ...tail.reverse());
        break;
      }
      tail.push(path.basename(abs));
      abs = parent;
    }
  }
  return canonical(abs, platform);
}

/** String rules of normPath without touching the filesystem: forward slashes, case-fold on Windows, no trailing slash. */
export function canonical(p: string, platform: NodeJS.Platform = process.platform): string {
  let out = p.replace(/\\/g, '/');
  if (platform === 'win32') out = out.toLowerCase();
  return out.length > 1 && !/^[a-z]:\/$/i.test(out) ? out.replace(/\/+$/, '') : out;
}

/** Both arguments must already be normalized with normPath. */
export function isUnder(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith('/') ? parent : parent + '/');
}

/** Relative path from a normalized root to a normalized child, with forward slashes. */
export function relTo(root: string, child: string): string {
  return child === root ? '' : child.slice(root.length + (root.endsWith('/') ? 0 : 1));
}

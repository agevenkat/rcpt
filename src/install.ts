import fs from 'node:fs';
import path from 'node:path';
import { git } from './git.js';
import { CONFIG_FILE, DEFAULT_CONFIG } from './config.js';
import { NOTES_REF } from './notes.js';

// Everything init changes is recorded in <git-common-dir>/rcpt/install.json so uninstall can undo
// exactly that and nothing else.

export const BLOCK_START = '# >>> rcpt >>>';
export const BLOCK_END = '# <<< rcpt <<<';

export type HookName = 'post-commit' | 'pre-push' | 'commit-msg';

interface HookRecord {
  name: HookName;
  path: string;
  /** created: we made the file. inserted: our block was added to an existing shell hook.
   *  wrapped: a non-shell hook was moved aside and is exec'd by our wrapper. lefthook: block in lefthook-local.yml. */
  action: 'created' | 'inserted' | 'wrapped' | 'lefthook';
  chainedPath?: string;
  lefthookCreatedFile?: boolean;
}

interface ConfigRecord {
  key: string;
  value: string;
}

export interface InstallRecord {
  version: 1;
  hooks: HookRecord[];
  config: ConfigRecord[];
  createdFiles: string[];
}

export interface CliCommand {
  node: string;
  script: string;
}

const recordPath = (root: string) => path.join(commonDir(root), 'rcpt', 'install.json');

function commonDir(root: string): string {
  return path.resolve(root, git(root, ['rev-parse', '--git-common-dir']).trim());
}

export function readRecord(root: string): InstallRecord | null {
  try {
    return JSON.parse(fs.readFileSync(recordPath(root), 'utf8')) as InstallRecord;
  } catch {
    return null;
  }
}

function saveRecord(root: string, rec: InstallRecord) {
  fs.mkdirSync(path.dirname(recordPath(root)), { recursive: true });
  fs.writeFileSync(recordPath(root), JSON.stringify(rec, null, 2) + '\n');
}

/** POSIX-sh single quoting; Windows paths use forward slashes, which Git for Windows' sh accepts. */
const shq = (s: string) => `'${s.replace(/\\/g, '/').replace(/'/g, `'\\''`)}'`;

/**
 * The block placed in hook scripts. It backgrounds rcpt with all output discarded, so the hook returns in
 * milliseconds and can't print anything or fail the git command. If rcpt is gone it does nothing.
 */
export function hookBlock(name: HookName, cli: CliCommand): string {
  // post-commit captures HEAD now: by the time the background process starts, another commit may exist.
  const args = name === 'pre-push' ? 'hook pre-push "$1"' : name === 'commit-msg' ? 'hook commit-msg "$1"' : 'hook post-commit "$(git rev-parse HEAD 2>/dev/null)"';
  // commit-msg must finish before git reads the message, so it runs in the foreground (opt-in only).
  const run = name === 'commit-msg' ? `rcpt_run ${args} </dev/null >/dev/null 2>&1 || true` : `(rcpt_run ${args} </dev/null >/dev/null 2>&1 &)`;
  return [
    `${BLOCK_START} managed by rcpt; remove with \`rcpt uninstall\``,
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a JS template
    'if [ -z "${RCPT_DISABLE:-}" ]; then',
    `  if [ -f ${shq(cli.script)} ] && [ -x ${shq(cli.node)} ]; then rcpt_run() { ${shq(cli.node)} ${shq(cli.script)} "$@"; }`,
    '  elif command -v rcpt >/dev/null 2>&1; then rcpt_run() { rcpt "$@"; }',
    '  else rcpt_run() { :; }; fi',
    `  ${run}`,
    'fi',
    BLOCK_END,
  ].join('\n');
}

function removeBlock(text: string): string {
  const re = new RegExp(`${escapeRe(BLOCK_START)}[\\s\\S]*?${escapeRe(BLOCK_END)}\\n?`, 'g');
  return text.replace(re, '');
}
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

type HookTarget = { kind: 'file'; path: string } | { kind: 'lefthook'; config: string };

/** Where a hook should go: Husky's user hooks dir, lefthook's local config, or git's hooks dir. */
export function hookTarget(root: string, name: HookName): HookTarget {
  const lefthook = ['lefthook.yml', '.lefthook.yml', 'lefthook.yaml', '.lefthook.yaml'].find((f) => fs.existsSync(path.join(root, f)));
  if (lefthook) return { kind: 'lefthook', config: path.join(root, 'lefthook-local.yml') };
  let hooksPath = '';
  try {
    hooksPath = git(root, ['config', '--get', 'core.hooksPath']).trim();
  } catch {
    /* unset */
  }
  // Husky v9 sets core.hooksPath=.husky/_ (generated); v8 uses .husky. User hooks live in .husky/<name>.
  if (/(^|\/)\.husky(\/_)?\/?$/.test(hooksPath)) return { kind: 'file', path: path.join(root, '.husky', name) };
  return { kind: 'file', path: path.resolve(root, git(root, ['rev-parse', '--git-path', `hooks/${name}`]).trim()) };
}

export function installHook(root: string, name: HookName, cli: CliCommand, rec: InstallRecord): string {
  if (rec.hooks.some((h) => h.name === name)) return `${name}: already installed`;
  const block = hookBlock(name, cli);
  const target = hookTarget(root, name);

  if (target.kind === 'lefthook') {
    const existed = fs.existsSync(target.config);
    const text = existed ? fs.readFileSync(target.config, 'utf8') : '';
    if (new RegExp(`^${name}:`, 'm').test(text)) {
      return `${name}: lefthook-local.yml already defines ${name}; add this command to it yourself:\n    rcpt: { run: "rcpt hook ${name}${name === 'post-commit' ? '' : ' {1}'}" }`;
    }
    // Only the body: the YAML block carries the markers, so uninstall's marker match stays unambiguous.
    const cmd = block.split('\n').slice(1, -1).map((l) => `        ${l}`).join('\n');
    const yaml = `${BLOCK_START} managed by rcpt\n${name}:\n  commands:\n    rcpt:\n      run: |\n${cmd.replace(/"\$1"/g, '{1}')}\n${BLOCK_END}\n`;
    fs.writeFileSync(target.config, (text && !text.endsWith('\n') ? text + '\n' : text) + yaml);
    rec.hooks.push({ name, path: target.config, action: 'lefthook', lefthookCreatedFile: !existed && !rec.hooks.some((h) => h.action === 'lefthook') });
    return `${name}: added to lefthook-local.yml (run \`lefthook install\` if lefthook hasn't installed a ${name} hook yet)`;
  }

  const file = target.path;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, `#!/bin/sh\n${block}\n`, { mode: 0o755 });
    rec.hooks.push({ name, path: file, action: 'created' });
    return `${name}: created ${path.relative(root, file)}`;
  }
  const text = fs.readFileSync(file, 'utf8');
  const shebang = text.split('\n', 1)[0]!;
  if (/^#!.*\b(sh|bash|zsh|dash|ksh)\b/.test(shebang) || !text.startsWith('#!')) {
    // Shell hook: insert right after the shebang so an `exit` later in the script can't skip us.
    const lines = text.split('\n');
    const at = text.startsWith('#!') ? 1 : 0;
    lines.splice(at, 0, block);
    fs.writeFileSync(file, lines.join('\n'));
    rec.hooks.push({ name, path: file, action: 'inserted' });
    return `${name}: added to existing ${path.relative(root, file)}`;
  }
  // Non-shell hook (node, python, binary): move it aside and chain to it from a shell wrapper.
  const chained = `${file}.rcpt-chained`;
  fs.renameSync(file, chained);
  fs.writeFileSync(file, `#!/bin/sh\n${block}\nexec ${shq(chained)} "$@"\n`, { mode: 0o755 });
  rec.hooks.push({ name, path: file, action: 'wrapped', chainedPath: chained });
  return `${name}: wrapped existing ${path.relative(root, file)} (it still runs)`;
}

function uninstallHook(h: HookRecord): string {
  if (h.action === 'wrapped') {
    if (h.chainedPath && fs.existsSync(h.chainedPath)) fs.renameSync(h.chainedPath, h.path);
    return `${h.name}: restored original hook`;
  }
  if (!fs.existsSync(h.path)) return `${h.name}: already gone`;
  const rest = removeBlock(fs.readFileSync(h.path, 'utf8'));
  const empty = rest.replace(/^#!.*\n?/, '').trim() === '';
  if ((h.action === 'created' && empty) || (h.action === 'lefthook' && h.lefthookCreatedFile && rest.trim() === '')) {
    fs.rmSync(h.path);
    return `${h.name}: removed ${path.basename(h.path)}`;
  }
  fs.writeFileSync(h.path, rest);
  return `${h.name}: removed rcpt block from ${path.basename(h.path)}`;
}

/** The git config changes that let receipts travel with the repository. */
export function syncConfigChanges(root: string): ConfigRecord[] {
  const remotes = git(root, ['remote']).split('\n').filter(Boolean);
  const remote = remotes.includes('origin') ? 'origin' : remotes[0];
  const changes: ConfigRecord[] = [{ key: 'notes.rewriteRef', value: NOTES_REF }];
  if (remote) changes.unshift({ key: `remote.${remote}.fetch`, value: `+refs/notes/rcpt*:refs/notes/remotes/${remote}/rcpt*` });
  return changes;
}

function configHas(root: string, { key, value }: ConfigRecord): boolean {
  try {
    return git(root, ['config', '--local', '--get-all', key]).split('\n').includes(value);
  } catch {
    return false;
  }
}

export interface InitOptions {
  cli: CliCommand;
  /** Apply the git config changes and pre-push sync hook. */
  sync: boolean;
  /** Install the synchronous commit-msg hook for the opt-in trailer. */
  trailer: boolean;
}

export function init(root: string, o: InitOptions): string[] {
  const rec: InstallRecord = readRecord(root) ?? { version: 1, hooks: [], config: [], createdFiles: [] };
  const log: string[] = [];

  const cfg = path.join(root, CONFIG_FILE);
  if (!fs.existsSync(cfg)) {
    const { pricing: _p, ...defaults } = DEFAULT_CONFIG;
    fs.writeFileSync(cfg, JSON.stringify(defaults, null, 2) + '\n');
    rec.createdFiles.push(cfg);
    log.push(`created ${CONFIG_FILE}`);
  }

  log.push(installHook(root, 'post-commit', o.cli, rec));
  if (o.trailer) log.push(installHook(root, 'commit-msg', o.cli, rec));
  if (o.sync) {
    log.push(installHook(root, 'pre-push', o.cli, rec));
    for (const change of syncConfigChanges(root)) {
      if (configHas(root, change)) continue;
      git(root, ['config', '--local', '--add', change.key, change.value]);
      rec.config.push(change);
      log.push(`git config --add ${change.key} ${change.value}`);
    }
  }
  saveRecord(root, rec);
  return log;
}

export function uninstall(root: string): string[] {
  const rec = readRecord(root);
  if (!rec) return ['rcpt is not installed in this repository (no install record found)'];
  const log = [...rec.hooks].reverse().map(uninstallHook);
  for (const { key, value } of rec.config) {
    try {
      git(root, ['config', '--local', '--fixed-value', '--unset', key, value]);
      log.push(`git config --unset ${key} ${value}`);
    } catch {
      /* already removed */
    }
  }
  for (const f of rec.createdFiles) {
    if (fs.existsSync(f)) {
      fs.rmSync(f);
      log.push(`removed ${path.basename(f)}`);
    }
  }
  fs.rmSync(path.dirname(recordPath(root)), { recursive: true, force: true });
  return log;
}

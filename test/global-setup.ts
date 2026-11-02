import { execFileSync } from 'node:child_process';
import path from 'node:path';

// Hook tests run the built CLI exactly as git would, so build dist/ once before the suite.
export default function setup() {
  const root = path.resolve(import.meta.dirname, '..');
  execFileSync(process.execPath, [path.join(root, 'node_modules', 'tsup', 'dist', 'cli-default.js')], { cwd: root, stdio: 'ignore' });
}

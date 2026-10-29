// Writes the web loader (index.html) and the file index (starhermit-files.json)
// into the game's folder with `starhermit package --web .` — the folder is what
// the platform serves. The engine leaves development files out of the package
// (its default rules plus .starhermitignore). Run after every change, then
// commit both files. STARHERMIT names the runtime (default: the published
// 1.27.0 Linux runtime under ~/sh/runtime).
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fallback = join(homedir(), 'sh/runtime/1.27.0/starhermit-1.27.0-linux-x86_64/starhermit');
const exe = process.env.STARHERMIT || (existsSync(fallback) ? fallback : null);
if (!exe) { console.error('set STARHERMIT to the engine runtime'); process.exit(1); }
execFileSync(exe, ['package', '--web', '.'], { cwd: root, stdio: 'inherit' });

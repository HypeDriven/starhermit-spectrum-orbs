// Native client checks on the StarHermit engine: the TypeScript type check,
// `starhermit check .` (manifest, package, browser module linking, 120
// headless frames; any warning fails), then every tests/native/*.play script
// as a signed-out offscreen run (--render-check) that drives the real UI.
// Also checks that the committed web index (starhermit-files.json) matches
// the files, i.e. that `npm run package` ran after the last change. Today's
// Daily is solved here and played as tests/native/.daily.play (written at
// test time: the board follows the UTC day). STARHERMIT
// names the runtime (default: the published 1.22.0 Linux runtime under
// ~/sh/runtime); TSC the TypeScript compiler (default ~/sh/runtime/ts).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import { dailyScript } from '../tools/gen-plays.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fallback = join(homedir(), 'sh/runtime/1.22.0/starhermit-1.22.0-linux-x86_64/starhermit');
const exe = process.env.STARHERMIT || (existsSync(fallback) ? fallback : null);
const tsc = process.env.TSC || join(homedir(), 'sh/runtime/ts/node_modules/.bin/tsc');
let failed = 0;
const fail = (name, e) => { failed++; console.log(`not ok - ${name}\n${String(e.stderr || e.stdout || e.message || e).trim()}`); };

const { files: index, excluded = [] } = JSON.parse(readFileSync(join(root, 'starhermit-files.json'), 'utf8'));
const left = (f) => excluded.some((e) => (e.endsWith('/') ? f.startsWith(e) : f === e));
const tracked = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '--deduplicate'], { cwd: root, encoding: 'utf8' })
  .split('\n').filter((f) => f && f !== 'starhermit-files.json' && !left(f) && !f.split('/').some((p) => p.startsWith('.')));
const stale = tracked.filter((f) => {
  let data; try { data = readFileSync(join(root, f)); } catch { return false; }
  return !index[f] || index[f].sha256 !== createHash('sha256').update(data).digest('hex');
}).concat(Object.keys(index).filter((f) => !tracked.includes(f)));
if (stale.length) fail('web index is up to date', `stale (run npm run package): ${stale.join(', ')}`);
else console.log('ok - web index matches the files');

if (existsSync(tsc)) {
  try { execFileSync(tsc, ['-p', '.'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); console.log('ok - tsc'); }
  catch (e) { fail('tsc', e); }
} else console.log('SKIP tsc: set TSC to a TypeScript 5 compiler');

if (!exe) {
  console.log('SKIP engine checks: set STARHERMIT to the engine runtime');
  process.exit(failed ? 1 : 0);
}
try {
  const out = execFileSync(exe, ['check', '.', '--quiet'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const warnings = out.split('\n').filter((l) => /^warning/i.test(l));
  if (warnings.length) fail('starhermit check', warnings.join('\n'));
  else console.log('ok - starhermit check');
} catch (e) { fail('starhermit check', e); }
writeFileSync(join(root, 'tests', 'native', '.daily.play'), dailyScript(new Date().toISOString().slice(0, 10)));
const only = process.argv.slice(2);
for (const f of readdirSync(join(root, 'tests', 'native')).filter((n) => n.endsWith('.play') && (!only.length || only.some((o) => n.includes(o)))).sort()) {
  try {
    execFileSync(exe, ['.', '--render-check', '--guest', '--script', `tests/native/${f}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...(process.env.SHOTS ? { STARHERMIT_RENDER_CHECK_PNG: process.env.SHOTS } : {}) } });
    console.log(`ok - ${f}`);
  } catch (e) { fail(f, e); }
}
console.log(failed ? `NATIVE FAIL — ${failed} failed` : 'NATIVE PASS');
process.exit(failed ? 1 : 0);

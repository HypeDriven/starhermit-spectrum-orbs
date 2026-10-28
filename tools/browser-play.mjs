// Plays the web package in Chrome on the machine's GPU (~/games/tools/
// gpu-chrome.mjs; GPU_ADAPTER=software for headless SwiftShader), the loader
// index.html that `npm run package` writes, at a desktop viewport, a phone
// (DPR 3) and a phone held sideways (DPR 3): on the desktop Journey stage 1
// is won by mouse clicks on the numbered tube labels, stage 2 by clicks on
// the 3D tubes themselves (the gallery's ray picking), with a pause by
// Escape; on the phone Learn lessons 1-2 are played by finger on the tube
// labels; sideways today's Daily is won by finger on the board-status chips
// (each board solved here with the rules). Widgets are found through the
// page's accessibility mirror of the engine's UI. Screenshots of each step go
// to --shots. Fails on console errors or warnings, the runtime's error screen,
// or a view that does not finish.
//   node tools/browser-play.mjs [GAME_DIR] [--shots OUT_DIR]
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
const require = createRequire(import.meta.url);
const Rules = require('../js/rules.js');
const Content = require('../js/content.js');

const args = process.argv.slice(2);
const dir = resolve(args[0] && !args[0].startsWith('--') ? args[0] : '.');
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const shots = opt('--shots', null);

function findPlaywright() {
  const roots = [dir, resolve(dir, '..'), ...readdirSync(resolve(dir, '..')).map((d) => resolve(dir, '..', d))];
  for (const r of roots) {
    const p = join(r, 'node_modules', 'playwright-core');
    if (existsSync(p)) return createRequire(join(r, 'package.json'))('playwright-core');
  }
  throw new Error('playwright-core not found');
}
const { chromium } = findPlaywright();

const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.ts': 'text/plain',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav', '.mp3': 'audio/mpeg' };
const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^\/+/, '') || 'index.html';
  if (path === 'api/v1/time') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ serverTime: Date.now(), serverTimeIso: new Date().toISOString() })); return; }
  const parts = path.split('/');
  if (parts.some((p) => p.startsWith('.') || p === '..') || ['tests', 'tools', 'node_modules'].includes(parts[0])) { res.writeHead(404).end(); return; }
  const file = join(dir, path);
  if (!existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const views = [
  { name: 'desktop', viewport: { width: 1440, height: 900 } },
  { name: 'phone', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
  { name: 'landscape', viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
];

const { launchChrome } = await import('/home/albert/games/tools/gpu-chrome.mjs');
const { browser, gpu, close } = await launchChrome(chromium);
console.log(`# chrome on ${gpu}`);
let failed = false;
for (const v of views) {
  const ctx = await browser.newContext({ viewport: v.viewport, isMobile: v.isMobile, hasTouch: v.hasTouch, deviceScaleFactor: v.deviceScaleFactor });
  const page = await ctx.newPage();
  const cdp = v.hasTouch ? await ctx.newCDPSession(page) : null;
  const problems = [];
  const environment = /^No available adapters\.$|GL Driver Message/;
  page.on('console', (m) => {
    const platformRoute = /\/api\//.test(m.location()?.url ?? '');
    if ((m.type() === 'error' || m.type() === 'warning') && !environment.test(m.text()) && !platformRoute) problems.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400 && !/\/api\//.test(r.url())) problems.push(`http ${r.status()}: ${r.url()}`); });
  await page.goto(url, { waitUntil: 'load', timeout: 120000 });
  const started = await page.waitForFunction(() => ['running', 'error'].includes(document.documentElement.dataset.starhermit), null, { timeout: 90000 }).then(() => true, () => false);
  await page.waitForTimeout(4000);
  const shot = async (name) => { if (shots) { mkdirSync(shots, { recursive: true }); await page.screenshot({ path: join(shots, `${v.name}-${name}.png`) }); } };
  const find = (name) => page.getByRole('button', { name, exact: true }).or(page.getByRole('checkbox', { name, exact: true })).or(page.getByText(name, { exact: true })).first();
  /** A tap / click at window coordinates (CSS px). */
  const tapAt = async (x, y) => {
    if (cdp) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
      await page.waitForTimeout(80);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else await page.mouse.click(x, y);
    await page.waitForTimeout(250);
  };
  /** A press on a widget (or a table target): the mouse on the desktop, a finger on the phones. */
  const press = async (name) => {
    const el = find(name);
    await el.waitFor({ timeout: 15000 });
    const b = await el.boundingBox();
    const x = b.x + b.width / 2, y = b.y + b.height / 2;
    if (cdp) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
      await page.waitForTimeout(80);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else await page.mouse.click(x, y);
    await page.waitForTimeout(250);
  };
  let reached = false;
  const stateOf = (lv) => Rules.createState({ contentId: lv.id, seed: lv.seed, colors: lv.colors, tubeCount: lv.tubeCount, capacity: lv.capacity, stacks: lv.stacks || null, limits: lv.limits || {} });
  const results = async () => { await page.getByText('Total', { exact: true }).first().waitFor({ timeout: 90000 }); await page.waitForTimeout(800); };
  const started2 = async () => { await page.getByText('Medal pace', { exact: true }).first().waitFor({ timeout: 60000 }); await page.waitForTimeout(3500); };
  /** One pour: by the tube labels, the chips, or the 3D tube under its label. */
  const tube = async (i, how) => {
    if (how === 'chips') { await press(new RegExp(`^Tube ${i + 1}:`)); return; }
    const el = page.getByRole('button', { name: `Tube ${i + 1}`, exact: true }).first();
    await el.waitFor({ timeout: 15000 });
    const b = await el.boundingBox();
    if (how === 'labels') await tapAt(b.x + b.width / 2, b.y + b.height / 2);
    else await tapAt(b.x + b.width / 2, b.y + b.height + 130);
  };
  const playBoard = async (lv, how) => {
    for (const m of Rules.solve(stateOf(lv), { maxNodes: 400000 })) {
      await tube(m.from, how);
      await page.waitForTimeout(150);
      await tube(m.to, how);
      await page.waitForTimeout(650);
    }
  };
  try {
    await shot('title');
    if (v.name === 'desktop') {
      await press('Play');
      await press('Begin');
      await started2();
      await shot('journey-1');
      await playBoard(Content.JOURNEY[0], 'labels');
      await results();
      await shot('journey-1-results');
      await press('Next stage');
      await started2();
      await page.keyboard.press('Escape');
      await find('Resume').waitFor({ timeout: 15000 });
      await page.waitForTimeout(500);
      await shot('pause');
      await press('Resume');
      await page.waitForTimeout(800);
      await playBoard(Content.JOURNEY[1], 'tubes');
      await results();
      await shot('journey-2-results');
    } else if (v.name === 'phone') {
      await press('Learn to Play');
      await page.getByText(/^Lesson 1 of 5/).first().waitFor({ timeout: 60000 });
      await page.waitForTimeout(1500);
      await shot('lesson-1');
      await tube(0, 'labels'); await page.waitForTimeout(200); await tube(2, 'labels');
      await page.getByText(/^Lesson 2 of 5/).first().waitFor({ timeout: 30000 });
      await page.waitForTimeout(1200);
      await tube(0, 'labels'); await page.waitForTimeout(200); await tube(2, 'labels'); await page.waitForTimeout(800);
      await tube(0, 'labels'); await page.waitForTimeout(200); await tube(2, 'labels');
      await page.getByText(/^Lesson 3 of 5/).first().waitFor({ timeout: 30000 });
      await page.waitForTimeout(800);
      await shot('lesson-3');
    } else {
      const daily = Content.dailyForDate(new Date().toISOString().slice(0, 10));
      await press('Daily Challenge');
      await started2();
      await shot('daily');
      await playBoard(daily, 'chips');
      await results();
      await shot('daily-results');
    }
    reached = true;
  } catch (e) { problems.push(`play: ${String(e.message || e).split('\n')[0]}`); await shot('failed'); }
  const state = await page.evaluate(() => document.documentElement.dataset.starhermit ?? '');
  const ok = started && state === 'running' && problems.length === 0 && reached;
  failed ||= !ok;
  console.log(`${ok ? 'ok' : 'not ok'} - ${v.name} played: started=${started} state=${state || '-'} played=${reached}`);
  for (const p of problems) console.log(`  ${p}`);
  await ctx.close();
}
await close();
server.close();
process.exit(failed ? 1 : 0);

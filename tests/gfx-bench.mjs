// Graphics benchmark hook for tools/gfx-bench.mjs (dev-only): picks a preset in Settings → Graphics,
// starts Journey with the visible title and setup buttons and keeps solving boards by clicking the
// on-screen tube chips (the solver's sequence, computed once per board, as the e2e does) — orbs lift,
// arc and drop, bursts fire on completed tubes, the mobiles spin and motes drift; a solved board goes
// to the next stage.
export const presets = ['low', 'balanced', 'high', 'ultra'];
export const levels = { low: 0, balanced: 4, high: 10, ultra: 17 };

export async function setPreset(page, preset) {
  await page.waitForFunction(() => window.SpectrumGame && window.SpectrumGame.fsm === 'title', null, { timeout: 30000 });
  await page.click('#topbar [data-action="settings"]');
  await page.waitForSelector('#screen-settings:not([hidden])');
  await page.locator('#gfx-section').scrollIntoViewIfNeeded();
  await page.selectOption('#set-tier', preset);
  await page.waitForFunction((p) => document.body.dataset.gfxPreset === p, preset);
  await page.locator('#screen-settings [data-action="close-overlay"]').scrollIntoViewIfNeeded();
  await page.click('#screen-settings [data-action="close-overlay"]');
  await page.waitForSelector('#screen-settings', { state: 'hidden' });
}

const solution = (page) => page.evaluate(() => {
  const s = window.SpectrumGame.session.state;
  const sol = window.SpectrumRules.solve(s, { maxNodes: 400000 });
  return sol ? sol.map((m) => [m.from, m.to]) : [];
});

async function pick(page, i) {
  await page.click(`#board-status button[data-tube="${i}"]`, { timeout: 2000 });
  await page.waitForFunction(() => !window.SpectrumGame.inputLocked, null, { timeout: 4000 }).catch(() => {});
}

export async function start(page) {
  await page.click('#screen-title [data-action="play-journey"]');
  await page.waitForFunction(() => window.SpectrumGame && window.SpectrumGame.fsm === 'setup', null, { timeout: 10000 });
  await page.click('#btn-begin');
  await page.waitForFunction(() => window.SpectrumGame.fsm === 'active', null, { timeout: 20000 });
  let open = true;
  page.once('close', () => { open = false; });
  (async () => {
    let moves = [];
    while (open) {
      try {
        const fsm = await page.evaluate(() => window.SpectrumGame.fsm);
        if (fsm === 'results') {
          moves = [];
          await page.click('#btn-results-next', { timeout: 2000 });
        } else if (fsm === 'active') {
          if (!moves.length) moves = await solution(page);
          const m = moves.shift();
          if (m) { await pick(page, m[0]); await pick(page, m[1]); }
        }
      } catch (e) { moves = []; if (!open) return; if (process.env.BENCH_DEBUG) console.error(e.message); }
      await page.waitForTimeout(350).catch(() => {});
    }
  })();
  await page.waitForTimeout(1500);
}

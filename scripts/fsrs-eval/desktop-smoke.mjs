/** Exercise real review buttons and read back the isolated SQLite and IPC state. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { chromium, expect } from '@playwright/test';
import { FSRS7Algorithm, FSRS7_DEFAULT_WEIGHTS, FSRS7_MODEL_BOUNDS } from 'ts-fsrs/models/fsrs-7';

const day = 86_400_000;
const model = new FSRS7Algorithm(FSRS7_DEFAULT_WEIGHTS, FSRS7_MODEL_BOUNDS);
const invoke = (page, cmd, args = {}) => page.evaluate(({ cmd, args }) => globalThis.__TAURI_INTERNALS__.invoke(cmd, args), { cmd, args });

export async function smokeDesktop(shell, root, data) {
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Electron DevTools endpoint did not appear')), 40_000);
    shell.once('exit', code => { clearTimeout(timer); reject(new Error(`Electron exited: ${code}`)); });
    let output = '';
    shell.stderr.on('data', chunk => {
      process.stderr.write(chunk);
      output = (output + chunk).slice(-8000);
      const ws = /DevTools listening on (ws:\/\/[^\s]+)/.exec(output)?.[1];
      if (ws) { clearTimeout(timer); resolve(ws); }
    });
  });
  const browser = await chromium.connectOverCDP(endpoint);
  try {
    const context = browser.contexts()[0];
    const page = context.pages()[0] ?? await context.waitForEvent('page', { timeout: 40_000 });
    await page.waitForFunction(() => !!globalThis.__TAURI_INTERNALS__?.invoke, undefined, { timeout: 40_000 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const agree = page.getByRole('button', { name: /我已阅读并同意|I have read and agree/ });
    await agree.click({ timeout: 55_000 });
    const dock = page.getByTestId('wb-dock');
    await dock.waitFor({ state: 'visible', timeout: 45_000 });
    const browse = page.getByRole('button', { name: /先随便看看|Just look around first/ });
    if (await browse.isVisible()) await browse.click();
    const skip = page.getByTestId('wb-empty-tour-skip');
    if (await skip.isVisible()) await skip.click();
    const states = await invoke(page, 'plugin:host|status');
    assert.ok(!states.some(state => state.id === 'dstu.review'), JSON.stringify(states));
    const blank = await invoke(page, 'fsrs_get_memory_overview');
    assert.deepEqual(blank.curve, { model: 'fsrs-7' });
    assert.equal(blank.memorizedCount, 0);

    // Seed with real save/enqueue commands; only this new library is writable.
    async function createCard(front) {
      const back = 'Answer for ' + front;
      const saved = await invoke(page, 'save_anki_cards', { request: { document_id: 'fsrs7-desktop-smoke', options: null,
        cards: [{ id: null, front, back, text: null, tags: [], images: [], fields: { Front: front, Back: back }, template_id: null }] } });
      assert.equal(saved.failed.length, 0);
      const queued = await invoke(page, 'fsrs_enqueue_cards', { ankiCardIds: saved.savedIds });
      return queued.states[0];
    }
    const card = await createCard('FSRS-7 试跑卡');
    const expected = await invoke(page, 'fsrs_preview_intervals', { cardStateId: card.id });
    assert.equal(expected.intervals.length, 4);
    assert.equal(expected.intervals[2].intervalMs, 600_000);
    await dock.getByTestId('wb-dock-item-__apps__').getByRole('button').click();
    await page.getByTestId('wb-apps-item-flashcards').click();
    await page.locator('[data-flashcards-app] .wb-fc-today').getByRole('button', { name: /^(开始复习|Start Review)$/i }).last().click({ timeout: 20_000 });
    await page.locator('[data-flashcards-app]').getByRole('button', { name: /^(显示答案|Show answer)$/i }).last().click();
    const good = page.locator('[data-flashcards-app] button[data-rating="3"]');
    await expect(good).toContainText(/10.*(?:分|min|m)/i);
    await page.screenshot({ path: join(root, 'rating.png') });
    // The reviewer intentionally ignores pointer ratings for 280 ms after reveal.
    await page.waitForTimeout(300);
    await good.click();
    const slots = JSON.parse(readFileSync(join(data, 'slots/state.json'), 'utf8'));
    const db = new DatabaseSync(join(data, 'slots', slots.active, 'mistakes.db'), { readOnly: true });
    try {
      const active = db.prepare(`SELECT l.*, m.stability_fast AS fast FROM fsrs_review_logs l
        JOIN fsrs7_log_memory m ON m.log_id = l.id WHERE l.card_state_id = ?1 AND l.deleted_at IS NULL ORDER BY l.rowid DESC`);
      await expect.poll(() => active.all(card.id).length).toBe(1);
      const rated = active.get(card.id);
      assert.equal(rated.fsrs_params_version, 'ts-fsrs-7@6.0.0');
      assert.equal(rated.due_after_ms - rated.review_ms, expected.intervals[2].intervalMs);
      assert.equal(rated.fast, model.next_state(null, 0, 3).stabilityFast);
      await page.getByRole('button', { name: /^(撤销评分|Undo review|Undo rating|Undo)$/i }).last().click();
      await expect.poll(() => active.all(card.id).length).toBe(0);
      const restored = db.prepare('SELECT due_ms, reps, state FROM fsrs_card_states WHERE id = ?1').get(card.id);
      assert.deepEqual({ ...restored }, { due_ms: card.dueMs, reps: 0, state: 0 });
      await page.locator('[data-flashcards-app]').getByRole('button', { name: /^(显示答案|Show answer)$/i }).last().click();
      await page.waitForTimeout(300);
      await good.click();
      await expect.poll(() => active.all(card.id).length).toBe(1);
      // Advance this isolated card to a formal review through the same renderer IPC.
      const rateGood = () => invoke(page, 'fsrs_rate', {
        cardStateId: card.id, rating: 3, durationMs: 1000, clientOpId: crypto.randomUUID(),
      });
      assert.equal((await rateGood()).cardState.state, 2);
      assert.equal((await rateGood()).cardState.state, 2);
      const stats = await invoke(page, 'fsrs_get_review_statistics');
      assert.equal(stats.model, 'fsrs-7');
      assert.equal(stats.ratingDistribution.total, 3);
      assert.equal(stats.stateBreakdown.review, 1);
      assert.equal(stats.retention.youngReviews + stats.retention.matureReviews, 1);
      assert.equal(stats.retention.overallPassRate, 1);
      const overview = await invoke(page, 'fsrs_get_memory_overview');
      assert.deepEqual(overview.trueRetention, { windowDays: 30, reviews: 1, passed: 1 });
      const latest = active.get(card.id);
      assert.equal(overview.recent[0].curve.stabilityFast, latest.fast);
      assert.equal(overview.averageRetrievability, model.curve((overview.generatedAtMs - latest.review_ms) / day, {
        stability: latest.stability_after, difficulty: latest.difficulty_after, stabilityFast: latest.fast,
      }).retrievability);
      const history = await invoke(page, 'fsrs_get_card_memory_history', { cardStateId: card.id });
      assert.equal(history.reviews.length, 3);
      assert.equal(history.reviews.at(-1).curve.stabilityFast, latest.fast);
      // Switch from the session back to the regular Flashcards statistics tab.
      const statsTab = page.locator('[data-flashcards-app]').getByRole('button', { name: /^(统计|Statistics)$/i });
      if (!(await statsTab.isVisible())) {
        await page.getByRole('button', { name: /返回今日|结束复习|退出|Back to Today|End session|Exit|Finish/i }).first().click();
      }
      await statsTab.click();
      const panel = page.getByTestId('fsrs-memory-curve');
      await expect(panel).toContainText('FSRS-7');
      await expect(panel.locator('[data-kind="target"]').first()).toBeVisible();
      await expect(panel).toContainText(/当前预计回忆率|estimated recall|estimated retrievability/i);
      await expect(panel).toContainText(/答对 1 \/ 1 次|1 \/ 1 correct/i);
      await expect(page.locator('.wb-fcx-metric').filter({ hasText: /已入队总数|total in queue/i }).locator('dd')).toHaveText('1');
      await expect(page.getByTestId('fsrs-retention-insights')).toContainText(/试跑使用 FSRS-7 默认参数|default FSRS-7 parameters/i);
      await panel.scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(root, 'statistics.png') });
      await panel.getByRole('button', { name: /复习历史|review history/i }).first().click();
      await expect(panel.getByRole('img', { name: /3 次复习的记忆曲线|memory curve.*3|3.*memory curve/i })).toBeVisible();
      await expect(panel.getByTestId('fsrs-memory-history').locator('ol > li')).toHaveCount(3);
      await panel.scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(root, 'history.png') });
    } finally { db.close(); }
    console.log('FSRS-7 desktop smoke passed: preview, actual due, undo, rerating, statistics and history.');
  } catch (error) {
    const page = browser.contexts()[0]?.pages()[0];
    if (page) await page.screenshot({ path: join(root, 'smoke-failure.png') }).catch(() => {});
    throw error;
  } finally { await browser.close(); }
}

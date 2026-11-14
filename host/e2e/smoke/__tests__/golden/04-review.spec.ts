/**
 * Golden path ④: two flashcards created and queued for FSRS review, one review session completed in the
 * flashcards app (show answer, rate "Good"), and the review log persisted in mistakes.db.
 *
 * Cards are created through the same commands the app's card-saving flows use
 * (`src/features/mindmap/utils/saveReciteMissCards.ts`: save_anki_cards → fsrs_enqueue_cards); the review
 * itself is done in the UI.
 */
import { expect, test, type Page } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, type LaunchedApp } from '../support/app.ts';
import { activeSlotDir, query } from '../support/db.ts';
import { collectHealth, describeFailures } from '../support/diagnostics.ts';
import { passFirstRun, waitForBridge } from '../support/onboarding.ts';

const CARDS = [
  { front: 'SMOKE 正面一', back: 'SMOKE 背面一' },
  { front: 'SMOKE 正面二', back: 'SMOKE 背面二' },
];

interface CardState { id: string; ankiCardId: string; state: number; reps: number; lastReviewMs: number | null }

const focused = (page: Page) => page.locator('[data-wb-window][data-focused="true"]');

test.describe.serial('④ flashcard review', () => {
  let app: LaunchedApp;
  let cardIds: string[] = [];

  test.beforeAll(async () => {
    app = await launchApp({ label: 'review' });
    await waitForBridge(app.page);
    await app.call('plugin:host|status', {}, 90_000);
    await passFirstRun(app.page);
  });
  test.afterAll(async () => {
    await app?.close();
  });

  test('cards are saved and queued for review', async () => {
    await app.mark('review-seed');
    const saved = await app.call<{ savedIds: string[]; failed: unknown[] }>('save_anki_cards', {
      request: {
        document_id: 'w12-smoke', options: null,
        cards: CARDS.map(({ front, back }) => ({ id: null, front, back, text: null, tags: ['w12'], images: [], fields: { Front: front, Back: back }, template_id: null })),
      },
    });
    expect(saved.failed).toEqual([]);
    expect(saved.savedIds).toHaveLength(CARDS.length);
    cardIds = saved.savedIds;
    const queued = await app.call<{ enqueued: number }>('fsrs_enqueue_cards', { ankiCardIds: cardIds });
    expect(queued.enqueued).toBe(CARDS.length);
    const due = await app.call<CardState[]>('fsrs_get_due', { limit: 50 });
    expect(due.map((d) => d.ankiCardId).sort()).toEqual([...cardIds].sort());
    expect(describeFailures(collectHealth(app, ['review-seed']))).toBe('');
  });

  test('a review session in the flashcards app rates every due card', async () => {
    const { page } = app;
    await app.mark('review-session');
    await page.getByTestId('wb-dock-apps-button').click();
    await page.getByTestId('wb-apps-item-flashcards').click();
    const win = focused(page);
    await expect(win.getByText(/2 张待复习/)).toBeVisible();
    await win.getByRole('button', { name: /开始复习|Start review/ }).click();
    for (let i = 0; i < CARDS.length; i += 1) {
      const front = win.getByText(/SMOKE 正面[一二]/).first();
      await expect(front).toBeVisible();
      const shown = (await front.innerText()).trim();
      await win.locator('.wb-fc-show-answer').click();
      const expectedBack = CARDS.find((c) => c.front === shown)?.back ?? '';
      await expect(win.getByText(expectedBack)).toBeVisible();
      // ReviewSessionScreen ignores pointer ratings within 280 ms of flipping (double-tap guard).
      await page.waitForTimeout(500);
      await win.locator('button.wb-fc-rate-btn[aria-keyshortcuts="3"]').click();
      await expect.poll(() => query(join(activeSlotDir(app.dataDir), 'mistakes.db'), 'select id from fsrs_review_logs').length).toBe(i + 1);
    }
    await page.screenshot({ path: join(app.root, 'review-finished.png') });
    expect(describeFailures(collectHealth(app, ['review-session']))).toBe('');
  });

  test('review logs and card states are persisted', async () => {
    const db = join(activeSlotDir(app.dataDir), 'mistakes.db');
    const logs = query<{ anki_card_id: string; rating: number; state_before: number; state_after: number; due_after_ms: number }>(db,
      'select anki_card_id, rating, state_before, state_after, due_after_ms from fsrs_review_logs order by created_at');
    expect(logs.map((l) => l.anki_card_id).sort()).toEqual([...cardIds].sort());
    for (const log of logs) {
      expect(log.rating).toBe(3);
      expect(log.state_before).toBe(0);
      expect(log.state_after).not.toBe(0);
      expect(log.due_after_ms).toBeGreaterThan(Date.now() - 60_000);
    }
    const states = query<{ anki_card_id: string; reps: number; last_review_ms: number | null }>(db,
      'select anki_card_id, reps, last_review_ms from fsrs_card_states');
    expect(states).toHaveLength(CARDS.length);
    for (const state of states) {
      expect(state.reps).toBe(1);
      expect(state.last_review_ms).not.toBeNull();
    }
    const stats = await app.call<Record<string, unknown>>('fsrs_get_review_statistics', {});
    test.info().annotations.push({ type: 'fsrs_get_review_statistics', description: JSON.stringify(stats).slice(0, 400) });
  });
});

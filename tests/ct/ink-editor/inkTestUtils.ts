import { expect } from '@playwright/experimental-ct-react';
import type { Page } from '@playwright/test';
import { INK_BOARD_DELTAS_STORE, INK_DRAFT_DB_NAME, INK_DRAFT_PAGES_STORE } from '@/features/ink/inkDraftDatabase';

export async function flushEditor(page: Page) {
  await page.evaluate(() => { delete window.__INK_EDITOR_FLUSH_RESULT__; });
  await page.getByTestId('ink-editor-flush').evaluate((button) => (button as HTMLButtonElement).click());
  await expect.poll(() => page.evaluate(() => window.__INK_EDITOR_FLUSH_RESULT__)).toBeDefined();
  return page.evaluate(() => window.__INK_EDITOR_FLUSH_RESULT__!);
}

export async function expectEditorFlush(page: Page) {
  expect(await flushEditor(page)).toEqual({ ok: true });
  await expect(page.getByTestId('ink-editor-save-state')).toHaveAttribute('data-state', 'saved');
}

export interface InkDraftWriteEvidence {
  store: string;
  documentId: string;
  pageId?: string;
  sequence?: number;
  objects: number;
}

declare global {
  interface Window {
    __INK_CT_DRAFT_WRITES__?: InkDraftWriteEvidence[];
  }
}

export async function watchInkDraftWrites(page: Page) {
  await page.evaluate(({ databaseName, pageStore, boardStore }) => {
    const writes: InkDraftWriteEvidence[] = [];
    window.__INK_CT_DRAFT_WRITES__ = writes;
    for (const method of ['put', 'add'] as const) {
      const original = IDBObjectStore.prototype[method];
      IDBObjectStore.prototype[method] = function (value: unknown, key?: IDBValidKey) {
        const stored = value as Record<string, unknown>;
        const draft = (stored?.draft ?? stored) as {
          document_id?: string;
          page_id?: string;
          sequence?: number;
          page?: { objects?: unknown[] };
          changed?: Array<{ objects?: unknown[] }>;
        };
        if (this.transaction.db.name === databaseName
          && (this.name === pageStore || this.name === boardStore)
          && draft.document_id && (draft.page || draft.changed)) {
          writes.push({
            store: this.name,
            documentId: draft.document_id,
            pageId: draft.page_id,
            sequence: draft.sequence,
            objects: draft.page?.objects?.length ?? draft.changed?.reduce((sum, chunk) => sum + (chunk.objects?.length ?? 0), 0) ?? 0,
          });
        }
        return key === undefined ? original.call(this, value) : original.call(this, value, key);
      };
    }
  }, { databaseName: INK_DRAFT_DB_NAME, pageStore: INK_DRAFT_PAGES_STORE, boardStore: INK_BOARD_DELTAS_STORE });
}

export async function readInkDraftWrites(page: Page, documentId?: string): Promise<InkDraftWriteEvidence[]> {
  return page.evaluate((id) => (window.__INK_CT_DRAFT_WRITES__ ?? []).filter((write) => !id || write.documentId === id), documentId);
}

export async function animationFrames(page: Page, count = 4) {
  await page.evaluate(async (frames) => {
    for (let index = 0; index < frames; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

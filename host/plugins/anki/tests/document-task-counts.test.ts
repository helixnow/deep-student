/** `get_document_task_counts` 的补充覆盖（Rust 无对应单测）。 */
import { describe, expect, it } from 'vitest';
import type { DocumentTask } from '../../../../contracts/ipc/generated/_shared.ts';
import { saveDocumentTaskWithCardsAtomic } from '../repository/anki-cards.ts';
import { createAnkiTestEnv } from './env.ts';

function task(id: string, status: DocumentTask['status']): DocumentTask {
  const now = '2026-08-24T00:00:00+00:00';
  return {
    id,
    document_id: 'doc-counts',
    original_document_name: 'counts',
    segment_index: 0,
    content_segment: 'fixture',
    status,
    created_at: now,
    updated_at: now,
    error_message: null,
    anki_generation_options_json: '{}',
  };
}

describe('get_document_task_counts', () => {
  it('counts_every_task_status_and_defaults_to_zero_for_unknown_document', async () => {
    // 计数只读 mistakes.document_tasks；不在用例预算内迁移无关的其它三个库。
    const env = await createAnkiTestEnv({ migrationScope: ['mistakes'] });
    try {
      const db = env.storage.database('mistakes');
      for (const [index, status] of (
        ['Pending', 'Processing', 'Streaming', 'Paused', 'Completed', 'Failed', 'Truncated', 'Cancelled'] as const
      ).entries()) {
        const row = task(`task-counts-${index}`, status);
        row.segment_index = index;
        saveDocumentTaskWithCardsAtomic(db, row, []);
      }

      await expect(
        env.host.invoke('get_document_task_counts', { documentId: 'doc-counts' }),
      ).resolves.toEqual({
        pending: 1,
        processing: 1,
        streaming: 1,
        paused: 1,
        completed: 1,
        failed: 1,
        truncated: 1,
        cancelled: 1,
        total: 8,
      });

      await expect(
        env.host.invoke('get_document_task_counts', { documentId: 'missing' }),
      ).resolves.toEqual({
        pending: 0,
        processing: 0,
        streaming: 0,
        paused: 0,
        completed: 0,
        failed: 0,
        truncated: 0,
        cancelled: 0,
        total: 0,
      });
    } finally {
      await env.dispose();
    }
  });
});

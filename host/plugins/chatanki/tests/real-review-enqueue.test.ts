/**
 * Real L15 enqueue evidence on the published main branch: boot the real
 * `review` plugin over migrated mistakes storage, seed document/card rows, and
 * execute `chatanki_enqueue_review` through `ctx.chatankiTools`. Card ownership
 * and task/card setup use the published L16 repositories; FSRS state writes
 * and the `fsrs://changed` event use the real L15 service. No provider is doubled.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import native from '../../../platform/native/index.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import agentSkills from '../../agent-skills/index.ts';
import anki from '../../anki/index.ts';
import review from '../../review/index.ts';
import type { AnkiCard, ToolExecutionContext } from '../api.ts';
import chatanki from '../index.ts';

const SESSION = 'session-real-enqueue';
const DOCUMENT = 'doc-real-enqueue';
const TASK = 'task-real-enqueue';
const CARD = 'card-real-enqueue';

function card(): AnkiCard {
  return {
    id: CARD, front: 'real front', back: 'real back', text: null, tags: [], images: [],
    task_id: TASK, is_error_card: false, error_content: null,
    created_at: '2026-08-24T00:00:00Z', updated_at: '2026-08-24T01:00:00Z',
    extra_fields: {}, template_id: null,
  };
}

it('chatanki_enqueue_review consumes the published L15 service and emits fsrs://changed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatanki-real-enqueue-'));
  const storage = createStorageService({
    baseDir: dir, dataLocalDir: path.join(dir, 'local'),
  });
  try {
    const migration = await storage.migrations.runAll();
    expect(migration.success).toBe(true);

    const events: Array<[string, unknown]> = [];
    const host = await createTestHost({
      app: { dataDir: dir },
      plugins: [native, anki, review, agentSkills, chatanki],
      provide: {
        paths: {
          appDataDir: dir,
          os: { home: dir, data: dir, temp: os.tmpdir() },
        },
        settings: {
          get: () => null,
          save: () => undefined,
          getSetting: () => null,
          saveSetting: () => undefined,
        },
        llm: {},
        storage,
      },
    });
    try {
      host.ctx.backendEvents.listen('fsrs://changed', (payload) => {
        events.push(['fsrs://changed', payload]);
      });
      const db = storage.database('mistakes');
      host.ctx.anki.documents.insertDocumentTask({
        id: TASK, document_id: DOCUMENT, original_document_name: 'test.md',
        segment_index: 0, content_segment: 'segment', status: 'Completed',
        created_at: '2026-08-24T00:00:00Z', updated_at: '2026-08-24T01:00:00Z',
        error_message: null, anki_generation_options_json: '{}',
      });
      host.ctx.anki.documents.setDocumentSessionSource(DOCUMENT, SESSION);
      expect(host.ctx.anki.cards.insertCardsForDocument(DOCUMENT, SESSION, [card()]))
        .toHaveLength(1);

      const context: ToolExecutionContext = {
        sessionId: SESSION,
        messageId: 'message-real-enqueue',
        blockId: 'block-real-enqueue',
        runId: 'run-real-enqueue',
        emitToolCallStart: () => undefined,
        emitToolCallEnd: () => undefined,
        emitToolCallError: () => undefined,
        saveToolBlock: () => undefined,
        warn: () => undefined,
      };

      const first = await host.ctx.chatankiTools.execute({
        id: 'call-real-enqueue', name: 'chatanki_enqueue_review',
        arguments: { documentId: DOCUMENT },
      }, context);
      expect(first.success).toBe(true);
      expect(first.output).toEqual({ status: 'ok', enqueued: 1, skipped: 0 });

      const rows = db.all<{ id: string; anki_card_id: string }>(
        'SELECT id, anki_card_id FROM fsrs_card_states WHERE anki_card_id = ?1', [CARD],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).not.toBe(CARD);

      expect(events).toHaveLength(1);
      expect(events[0]?.[0]).toBe('fsrs://changed');
      expect(events[0]?.[1]).toMatchObject({
        source: 'agent',
        action: 'enqueue',
        entityIds: [CARD],
        cardStateIds: [rows[0]!.id],
        runId: 'run-real-enqueue',
      });
      const payload = events[0]?.[1] as { cards: Array<Record<string, unknown>> };
      expect(payload.cards).toHaveLength(1);
      expect(payload.cards[0]?.ankiCardId).toBe(CARD);

      const second = await host.ctx.chatankiTools.execute({
        id: 'call-real-enqueue-again', name: 'chatanki_enqueue_review',
        arguments: { cardIds: [CARD] },
      }, context);
      expect(second.success).toBe(true);
      expect(second.output).toEqual({ status: 'ok', enqueued: 0, skipped: 1 });
      expect(events).toHaveLength(1);
    } finally {
      await host.dispose();
    }
  } finally {
    storage.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

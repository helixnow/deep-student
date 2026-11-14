import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import native from '../../../platform/native/index.ts';
import { createPaths } from '../../../platform/paths/index.ts';
import { createSettingsStore } from '../../../platform/settings/index.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import anki from '../../anki/index.ts';
import review from '../../review/index.ts';
import type { AnkiCard, ToolExecutionContext } from '../api.ts';
import chatanki from '../index.ts';

it('test_chatanki_get_cards_owned_snapshot_page_boundaries_and_filters through real public providers', async () => {
  // chatanki_executor.rs:15084-15137. Each Rust assertion is kept below;
  // unlike the older array-helper test, insertion/ownership/FSRS hydration are real.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatanki-owned-snapshot-'));
  const storage = createStorageService({ baseDir: dir, dataLocalDir: path.join(dir, 'local') });
  try {
    expect((await storage.migrations.runAll()).success).toBe(true);
    const paths = createPaths({ dataDir: dir, platform: 'linux', env: {
      HOME: dir, XDG_DATA_HOME: dir, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir,
    } });
    const host = await createTestHost({
      app: { dataDir: dir }, plugins: [native, anki, review, chatanki],
      provide: {
        paths, storage,
        settings: createSettingsStore({
          db: () => storage.database('mistakes'), secureStore: () => null, isSensitiveKey: () => false,
        }),
        llm: {}, // no LLM operation is part of get_cards
      },
    });
    try {
      const sessionId = 'session-get-page';
      const documentId = 'doc-get-page';
      const timestamp = '2026-07-13T00:00:00Z';
      host.ctx.anki.documents.insertDocumentTask({
        id: 'task-get-page', document_id: documentId, original_document_name: 'page.md',
        segment_index: 0, content_segment: 'segment', status: 'Completed',
        created_at: timestamp, updated_at: timestamp,
        error_message: null, anki_generation_options_json: '{}',
      });
      host.ctx.anki.documents.setDocumentSessionSource(documentId, sessionId);
      const cards: AnkiCard[] = [1, 2, 3, 4, 5].map((index) => ({
        id: `card-${index}`, task_id: 'task-get-page', front: `front-${index}`, back: 'back',
        text: null, tags: [], images: [], is_error_card: index === 2 || index === 4,
        error_content: null, created_at: timestamp,
        updated_at: index === 3 ? '2026-07-13T00:00:01Z'
          : index === 4 ? '2026-07-13T00:00:02Z' : timestamp,
        extra_fields: {}, template_id: null,
      }));
      const inserted = host.ctx.anki.cards.insertCardsForDocument(documentId, sessionId, cards);
      expect(inserted).toHaveLength(5); // Rust :15104 (real insert, not fixture array size)
      const context: ToolExecutionContext = {
        sessionId, messageId: 'message-get-page', blockId: 'block-get-page',
        emitToolCallStart: () => undefined, emitToolCallEnd: () => undefined,
        emitToolCallError: () => undefined, saveToolBlock: () => undefined, warn: () => undefined,
      };
      const page = async (filter: string, number: number, pageSize: number) => {
        const result = await host.ctx.chatankiTools.execute({
          id: `call-page-${filter}-${number}`, name: 'chatanki_get_cards',
          arguments: { documentId, filter, page: number, pageSize },
        }, context);
        expect(result.success, result.error).toBe(true);
        return result.output as { total: number; cards: Array<Record<string, unknown>> };
      };
      const first = await page('all', 1, 2);
      expect(first.total).toBe(5); // Rust :15112
      expect(first.cards).toHaveLength(2); // :15113
      expect(first.cards[0]!.id).toBe('card-1'); // :15114
      expect(first.cards[1]!.id).toBe('card-2'); // :15115
      const final = await page('all', 3, 2);
      expect(final.cards).toHaveLength(1); // :15119
      expect(final.cards[0]!.id).toBe('card-5'); // :15120
      const pastEnd = await page('all', 4, 2);
      expect(pastEnd.cards).toEqual([]); // :15123
      const errors = await page('error_only', 1, 10);
      expect(errors.total).toBe(2); // :15127
      expect(errors.cards[0]!.id).toBe('card-2'); // :15128
      expect(errors.cards[0]!.index).toBe(2); // :15129
      expect(errors.cards[1]!.id).toBe('card-4'); // :15130
      expect(errors.cards[1]!.index).toBe(4); // :15131
      const edited = await page('edited_only', 1, 10);
      expect(edited.total).toBe(2); // :15135
      expect(edited.cards[0]!.id).toBe('card-3'); // :15136
      expect(edited.cards[1]!.id).toBe('card-4'); // :15137
    } finally {
      await host.dispose();
    }
  } finally {
    storage.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

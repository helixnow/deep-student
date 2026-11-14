import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import native from '../../../platform/native/index.ts';
import { createSettingsStore } from '../../../platform/settings/index.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import anki from '../../anki/index.ts';
import chat from '../../chat/index.ts';
import review from '../../review/index.ts';
import type { AnkiCard, ToolExecutionContext } from '../api.ts';
import chatanki from '../index.ts';
import { CHATANKI_PREFERENCE_MEMORY_SETTING_KEY } from '../src/preference-memory.ts';

it('v2 serde Option subject defaults to null through a real card edit and preference persist', async () => {
  // anki_preference_memory.rs:124-135 derives Deserialize; subject is Option<String>.
  // No cards/settings/preferenceMemory/review provider is replaced here.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatanki-preference-decoder-'));
  const storage = createStorageService({ baseDir: dir, dataLocalDir: path.join(dir, 'local') });
  try {
    expect((await storage.migrations.runAll()).success).toBe(true);
    const host = await createTestHost({
      app: { dataDir: dir }, plugins: [native, chat, anki, review, chatanki],
      provide: {
        paths: { appDataDir: dir, os: { home: dir, data: dir, temp: os.tmpdir() } },
        settings: createSettingsStore({
          db: () => storage.database('mistakes'), secureStore: () => null,
          isSensitiveKey: () => false, // this test uses only the non-secret preference setting
        }),
        // No VFS or LLM operation is invoked. L04's real chatSession backs UI preflight.
        vfs: {}, llm: {}, storage,
      },
    });
    try {
      host.ctx.anki.documents.insertDocumentTask({
        id: 'task-pref', document_id: 'doc-pref', original_document_name: 'test.md',
        segment_index: 0, content_segment: 'segment', status: 'Completed',
        created_at: '2026-08-24T00:00:00Z', updated_at: '2026-08-24T00:00:00Z',
        error_message: null, anki_generation_options_json: '{}',
      });
      host.ctx.anki.documents.setDocumentSessionSource('doc-pref', 'session-pref');
      const card: AnkiCard = {
        id: 'card-pref', front: 'original question', back: 'answer', text: null,
        tags: [], images: [], task_id: 'task-pref', is_error_card: false, error_content: null,
        created_at: '2026-08-24T00:00:00Z', updated_at: '2026-08-24T00:00:00Z',
        extra_fields: {}, template_id: null,
      };
      const inserted = host.ctx.anki.cards.insertCardsForDocument('doc-pref', 'session-pref', [card]);
      expect(inserted).toHaveLength(1);
      host.ctx.anki.settings.saveSetting(CHATANKI_PREFERENCE_MEMORY_SETTING_KEY, JSON.stringify({
        entries: [{
          kind: 'template_preference', statement: 'prefer an existing template',
          confidence: 0.5, evidence_count: 1, last_evidence: 'existing evidence',
          first_seen_ms: 1, last_seen_ms: 1,
          // subject omitted, as accepted by serde Option<String>.
        }],
      }));
      const warnings: string[] = [];
      const context: ToolExecutionContext = {
        sessionId: 'session-pref', messageId: 'message-pref', blockId: 'block-pref',
        emitToolCallStart: () => undefined, emitToolCallEnd: () => undefined,
        emitToolCallError: () => undefined, saveToolBlock: () => undefined,
        warn: (message) => warnings.push(message),
      };
      const result = await host.ctx.chatankiTools.execute({
        id: 'call-pref', name: 'chatanki_update_card', arguments: {
          cardId: card.id, expectedVersion: inserted[0]!.updated_at,
          patch: { front: 'edited question' },
        },
      }, context);
      expect(result.success, result.error).toBe(true);
      expect(host.ctx.anki.cards.getCardForSession(card.id, 'session-pref')?.card.front)
        .toBe('edited question');
      expect(warnings).toEqual([]);
      const stored = JSON.parse(host.ctx.anki.settings.getSetting(CHATANKI_PREFERENCE_MEMORY_SETTING_KEY)!) as {
        entries: Array<{ subject: string | null; statement: string }>;
      };
      expect(stored.entries).toHaveLength(1);
      expect(stored.entries[0]!.subject).toBeNull();
      expect(stored.entries[0]!.statement).toBe('prefer an existing template');
    } finally {
      await host.dispose();
    }
  } finally {
    storage.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import native from '../../../platform/native/index.ts';
import { createSettingsStore } from '../../../platform/settings/index.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import anki from '../../anki/index.ts';
import { installWorkspaceCardReadScope } from '../../agent-workspace/api.ts';
import review from '../../review/index.ts';
import type { AnkiCard, ToolExecutionContext } from '../api.ts';
import chatanki from '../index.ts';
import {
  STATUS_NOT_FOUND, loadOwnedChatankiCard,
  resolveChatankiReadSession, verifyDocumentOwnership,
} from '../src/card-access.ts';

it('test_workspace_card_read_scope_never_relaxes_write_paths through real public providers', async () => {
  // Rust chatanki_executor.rs:16345-16384 manually installs this trusted scope.
  // This tests its safety rule, not the pending workspace/pipeline installation lifecycle.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatanki-real-read-scope-'));
  const storage = createStorageService({ baseDir: dir, dataLocalDir: path.join(dir, 'local') });
  try {
    expect((await storage.migrations.runAll()).success).toBe(true);
    const host = await createTestHost({
      app: { dataDir: dir }, plugins: [native, anki, review, chatanki],
      provide: {
        paths: { appDataDir: dir, os: { home: dir, data: dir, temp: dir } }, storage,
        settings: createSettingsStore({
          db: () => storage.database('mistakes'), secureStore: () => null, isSensitiveKey: () => false,
        }),
        llm: {}, // no LLM operation is part of this test
      },
    });
    try {
      const documentId = 'doc-scope-write';
      const coordinator = 'session-write-coordinator';
      const worker = 'session-write-worker';
      const timestamp = '2026-07-13T00:00:00Z';
      host.ctx.anki.documents.insertDocumentTask({
        id: 'task-scope-write', document_id: documentId, original_document_name: 'scope.md',
        segment_index: 0, content_segment: 'segment', status: 'Completed',
        created_at: timestamp, updated_at: timestamp,
        error_message: null, anki_generation_options_json: '{}',
      });
      host.ctx.anki.documents.setDocumentSessionSource(documentId, coordinator);
      const card: AnkiCard = {
        id: 'card-scope-write', task_id: 'task-scope-write', front: 'before', back: 'answer',
        text: null, tags: ['tag'], images: [], is_error_card: false, error_content: null,
        created_at: timestamp, updated_at: timestamp, extra_fields: {}, template_id: 'design-swiss',
      };
      const repo = host.ctx.anki.cards;
      expect(repo.insertCard(card)).toBe(true); // Rust :16349
      const initial = repo.getCardWithDocument(card.id)!.card;
      const context: ToolExecutionContext = {
        sessionId: worker, messageId: 'message-scope-write', blockId: 'block-scope-write',
        emitToolCallStart: () => undefined, emitToolCallEnd: () => undefined,
        emitToolCallError: () => undefined, saveToolBlock: () => undefined, warn: () => undefined,
      };
      const guard = installWorkspaceCardReadScope(worker, 'ws-write', coordinator);
      try {
        expect(resolveChatankiReadSession(repo, documentId, worker)).toBe(coordinator); // :16359-16361
        expect(() => verifyDocumentOwnership(repo, documentId, worker)).toThrow(); // :16363
        expect(() => loadOwnedChatankiCard(repo, card.id, worker))
          .toThrow(new Error(STATUS_NOT_FOUND)); // :16364-16368 (exact error text)
        const outcome = repo.updateCardIfVersionForSession(
          { ...card, front: 'must not be written' }, card.updated_at, worker,
        );
        expect(outcome.kind).toBe('notFound'); // :16378
        expect(repo.getCardWithDocument(card.id)!.card.front).toBe('before'); // :16384

        // Stronger entry-point evidence: production get_cards uses coordinator
        // read scope, but production update_card must reject the same worker.
        const readCall = {
          id: 'call-scope-read', name: 'chatanki_get_cards', arguments: { documentId },
        };
        const readable = await host.ctx.chatankiTools.execute(readCall, context);
        expect(readable.success, readable.error).toBe(true);
        expect(readable.output).toMatchObject({ status: 'ok', total: 1, cards: [{ id: card.id, front: 'before' }] });
        const denied = await host.ctx.chatankiTools.execute({
          id: 'call-scope-write', name: 'chatanki_update_card', arguments: {
            cardId: card.id, expectedVersion: card.updated_at, patch: { front: 'must not be written' },
          },
        }, context);
        expect(denied.success).toBe(false);
        expect(denied.error).toContain('statusNotFound');
        expect(repo.getCardWithDocument(card.id)!.card).toEqual(initial);

        guard.release();
        const revoked = await host.ctx.chatankiTools.execute({ ...readCall, id: 'call-scope-revoked' }, context);
        expect(revoked.success).toBe(false);
        expect(revoked.error).toContain('statusNotFound');
        expect(repo.getCardWithDocument(card.id)!.card).toEqual(initial);
      } finally {
        guard.release();
      }
    } finally {
      await host.dispose();
    }
  } finally {
    storage.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

// chatanki_executor.rs install_agent_hooks: chatanki fills the chat delete-gate
// reaper slot, so crash leftovers stop blocking session deletion (F2).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import native from '../../../platform/native/index.ts';
import { createSettingsStore } from '../../../platform/settings/index.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import anki from '../../anki/index.ts';
import chat from '../../chat/index.ts';
import review from '../../review/index.ts';
import chatanki from '../index.ts';

let dir = '';
let storage: ReturnType<typeof createStorageService>;
let host: TestHost;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatanki-stale-reaper-'));
  storage = createStorageService({ baseDir: dir, dataLocalDir: path.join(dir, 'local') });
  expect((await storage.migrations.runAll()).success).toBe(true);
  host = await createTestHost({
    app: { dataDir: dir }, plugins: [native, chat, anki, review, chatanki],
    provide: {
      paths: { appDataDir: dir, os: { home: dir, data: dir, temp: dir } }, storage,
      settings: createSettingsStore({
        db: () => storage.database('mistakes'), secureStore: () => null, isSensitiveKey: () => false,
      }),
      vfs: {}, llm: {},
      agentApproval: { clearSessionRemembered() {} },
    },
  });
}, 60_000);

afterAll(async () => {
  await host?.dispose();
  storage?.dispose();
  if (dir !== '') fs.rmSync(dir, { recursive: true, force: true });
});

function seedAnkiBlock(sessionId: string, startedAt: number): string {
  const db = storage.database('chat_v2');
  const blockId = `blk_${sessionId}`;
  db.run(`INSERT INTO chat_v2_sessions (id, mode, persist_status, created_at, updated_at)
    VALUES (?1, 'chat', 'active', '2026-11-07T00:00:00+00:00', '2026-11-07T00:00:00+00:00')`, [sessionId]);
  db.run(`INSERT INTO chat_v2_messages (id, session_id, role, block_ids_json, timestamp)
    VALUES (?1, ?2, 'assistant', ?3, ?4)`, [`msg_${sessionId}`, sessionId, JSON.stringify([blockId]), startedAt]);
  db.run(`INSERT INTO chat_v2_blocks (id, message_id, block_type, status, block_index, tool_name, started_at)
    VALUES (?1, ?2, 'anki_cards', 'running', 0, 'chatanki_run', ?3)`, [blockId, `msg_${sessionId}`, startedAt]);
  return blockId;
}

function blockRow(blockId: string) {
  return storage.database('chat_v2').get<{ status: string; error: string | null; tool_output_json: string | null }>(
    'SELECT status, error, tool_output_json FROM chat_v2_blocks WHERE id = ?1', [blockId])!;
}

function persistStatus(sessionId: string): string | undefined {
  return storage.database('chat_v2').pluck<string>('SELECT persist_status FROM chat_v2_sessions WHERE id = ?1', [sessionId]);
}

it('soft delete reaps an anki block idle past the two-minute grace window and marks it failed', async () => {
  const blockId = seedAnkiBlock('sess_stale_anki', Date.now() - 3 * 60 * 1000);
  await expect(host.invoke('chat_v2_soft_delete_session', { sessionId: 'sess_stale_anki' })).resolves.toBeNull();
  expect(persistStatus('sess_stale_anki')).toBe('deleted');
  const block = blockRow(blockId);
  expect(block.status).toBe('error');
  expect(block.error).toBe('blocks.ankiCards.errors.pipelineTimeout');
  expect(JSON.parse(block.tool_output_json!)).toMatchObject({ interrupted: { reason: 'stale_running_block' } });
});

it('a recently active anki block still blocks deletion', async () => {
  const blockId = seedAnkiBlock('sess_fresh_anki', Date.now());
  await expect(host.invoke('chat_v2_soft_delete_session', { sessionId: 'sess_fresh_anki' }))
    .rejects.toContain('Cannot delete session while ChatAnki generation is still running.');
  expect(blockRow(blockId).status).toBe('running');
  expect(persistStatus('sess_fresh_anki')).toBe('active');
});

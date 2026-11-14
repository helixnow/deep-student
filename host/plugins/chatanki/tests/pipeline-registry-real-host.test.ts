// chatanki_executor.rs:106–189 + install_agent_hooks: the live pipeline registry
// backs the chat delete-gate reaper and the kill-switch emergency cancel hook.
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
import { ChatAnkiPipelineRegistry } from '../src/pipeline-registry.ts';

let dir = '';
let storage: ReturnType<typeof createStorageService>;
let host: TestHost;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatanki-pipeline-registry-'));
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
      agentApproval: { clearSessionRemembered() {}, rejectAllPending: () => 0 },
    },
  });
}, 60_000);

afterAll(async () => {
  await host?.dispose();
  storage?.dispose();
  if (dir !== '') fs.rmSync(dir, { recursive: true, force: true });
});

function pipelines(): ChatAnkiPipelineRegistry {
  return (host.ctx.get('chatankiTools') as unknown as { pipelines: ChatAnkiPipelineRegistry }).pipelines;
}

function seedRunningAnkiBlock(sessionId: string, startedAt: number): string {
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

function blockStatus(blockId: string): string | undefined {
  return storage.database('chat_v2').pluck<string>('SELECT status FROM chat_v2_blocks WHERE id = ?1', [blockId]);
}

it('registry: re-registering a block replaces the token, release drops the key, parent cancellation propagates', () => {
  const registry = new ChatAnkiPipelineRegistry();
  let parentCancelled = false;
  const first = registry.register('blk_a', null);
  const second = registry.register('blk_a', () => parentCancelled);
  expect(registry.isActive('blk_a')).toBe(true);

  parentCancelled = true;
  expect(second.isCancelled()).toBe(true);
  expect(first.isCancelled()).toBe(false);
  const warnings: string[] = [];
  expect(registry.cancelAll('test', (message) => warnings.push(message))).toBe(0);
  expect(warnings).toEqual([]);

  first.release();
  expect(registry.isActive('blk_a')).toBe(false);
  second.release();
  expect(registry.isActive('blk_a')).toBe(false);
});

it('delete gate keeps a stale-looking block whose pipeline is still registered, and reaps it after release', async () => {
  const blockId = seedRunningAnkiBlock('sess_live_pipeline', Date.now() - 3 * 60 * 1000);
  const guard = pipelines().register(blockId, null);

  await expect(host.invoke('chat_v2_soft_delete_session', { sessionId: 'sess_live_pipeline' }))
    .rejects.toContain('Cannot delete session while ChatAnki generation is still running.');
  expect(blockStatus(blockId)).toBe('running');

  guard.release();
  await expect(host.invoke('chat_v2_soft_delete_session', { sessionId: 'sess_live_pipeline' })).resolves.toBeNull();
  expect(blockStatus(blockId)).toBe('error');
});

it('emergency stop cancels every registered pipeline without deregistering it', async () => {
  const live = pipelines().register('blk_kill_a', null);
  const untouched = pipelines().register('blk_kill_b', null);
  untouched.release();
  try {
    await host.invoke('chat_v2_emergency_stop', { reason: 'test_stop' });
    expect(live.isCancelled()).toBe(true);
    expect(untouched.isCancelled()).toBe(false);
    expect(pipelines().isActive('blk_kill_a')).toBe(true);
    expect(pipelines().cancelAll('again', () => {})).toBe(0);
  } finally {
    live.release();
    await host.invoke('chat_v2_resume_agents', {});
  }
});

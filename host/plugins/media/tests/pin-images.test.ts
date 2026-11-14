/**
 * `src/commands.rs:356-395` pin_images / unpin_images (no Rust test): production-entry
 * contract tests through `host.invoke`, with the real L22 `appCommandState`
 * (`modifyTempSession`, commands.rs:248-285) over the migrated `temp_sessions` table.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { createStorageService, type StorageServiceImpl } from '../../../platform/storage/service.ts';
// boundary-allow cross-plugin-impl: 真实 L22 appCommandState.modifyTempSession（temp_sessions 所有者）
import integration from '../../integration/index.ts';
import media from '../index.ts';

let dir: string;
let storage: StorageServiceImpl;
let db: DatabaseHandle;
let host: TestHost;
const settingsRows = new Map<string, string>();
let failSettings = false;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'l18-pin-images-'));
  storage = createStorageService({ baseDir: dir, dataLocalDir: dir });
  const report = await storage.migrations.runAll();
  expect(report.success).toBe(true);
  db = storage.database('mistakes');
  host = await createTestHost({
    plugins: [integration, media],
    provide: {
      storage,
      paths: { appDataDir: dir },
      settings: {
        get: (key: string) => settingsRows.get(key) ?? null,
        save: (key: string, value: string) => {
          if (failSettings) throw new Error('settings down');
          settingsRows.set(key, value);
        },
        delete: (key: string) => {
          if (failSettings) throw new Error('settings down');
          return settingsRows.delete(key);
        },
      },
    },
  });
}, 120_000);

afterAll(async () => {
  await host?.dispose();
  storage?.dispose();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  db.exec('DELETE FROM temp_sessions');
  settingsRows.clear();
  failSettings = false;
});

function insertSession(tempId: string): void {
  const session = {
    temp_id: tempId, question_images: [], analysis_images: [], user_question: '', ocr_text: '',
    ocr_note: null, tags: [], mistake_type: '', chat_category: '', chat_metadata: null,
    chat_history: [], initial_doc_attachments: null, pinned_images: null,
    created_at: '2026-09-24T00:00:00Z', exam_sheet: null, stream_state: 'in_progress',
    bridge_context: null, last_error: null,
  };
  db.run(
    `INSERT INTO temp_sessions (temp_id, session_data, stream_state, created_at, updated_at, last_error)
     VALUES (?1, ?2, 'in_progress', ?3, ?3, NULL)`,
    [tempId, JSON.stringify(session), session.created_at],
  );
}

function pinnedInDb(tempId: string): unknown {
  const row = db.get<{ session_data: string }>('SELECT session_data FROM temp_sessions WHERE temp_id = ?1', [tempId]);
  const data = JSON.parse(row!.session_data) as Record<string, unknown>;
  // models.rs:199 `skip_serializing_if = "Option::is_none"`: None is omitted, not null.
  return Object.hasOwn(data, 'pinned_images') ? data.pinned_images : 'absent';
}

it('pin_images sets the session pin, persists it and mirrors pinned_images:<id>', async () => {
  insertSession('t1');
  expect(await host.invoke('pin_images', { tempId: 't1', images: ['a', 'b'] })).toBe(true);
  expect(pinnedInDb('t1')).toEqual(['a', 'b']);
  expect(settingsRows.get('pinned_images:t1')).toBe('["a","b"]');
});

it('pin_images with an empty list clears the pin and deletes the setting', async () => {
  insertSession('t2');
  settingsRows.set('pinned_images:t2', '["x"]');
  expect(await host.invoke('pin_images', { tempId: 't2', images: [] })).toBe(true);
  expect(pinnedInDb('t2')).toBe('absent');
  expect(settingsRows.has('pinned_images:t2')).toBe(false);
});

it('unpin_images clears the pin and deletes the setting', async () => {
  insertSession('t3');
  await host.invoke('pin_images', { tempId: 't3', images: ['a'] });
  expect(await host.invoke('unpin_images', { tempId: 't3' })).toBe(true);
  expect(pinnedInDb('t3')).toBe('absent');
  expect(settingsRows.has('pinned_images:t3')).toBe(false);
});

it('settings failures are ignored like Rust `let _ =`', async () => {
  insertSession('t4');
  failSettings = true;
  expect(await host.invoke('pin_images', { tempId: 't4', images: ['a'] })).toBe(true);
  expect(await host.invoke('unpin_images', { tempId: 't4' })).toBe(true);
});

it('missing sessions propagate NotFound before touching settings', async () => {
  settingsRows.set('pinned_images:none', '["x"]');
  for (const run of [
    () => host.invoke('pin_images', { tempId: 'none', images: ['a'] }),
    () => host.invoke('unpin_images', { tempId: 'none' }),
  ]) {
    const error = await run().then(() => null, (e: unknown) => e);
    // host.invoke rejects with the CommandError's wire value (Rust AppError).
    expect(error).toMatchObject({ error_type: 'NotFound', message: '临时会话不存在' });
  }
  expect(settingsRows.get('pinned_images:none')).toBe('["x"]');
});

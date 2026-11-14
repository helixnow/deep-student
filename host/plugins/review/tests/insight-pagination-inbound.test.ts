import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createSettingsService } from '../../../platform/settings/index.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import pathsPlugin from '../../../platform/paths/index.ts';
import vfsReposPlugin from '../../vfs-repos/index.ts';
import notesPlugin from '../../notes/index.ts';
import memoryPlugin from '../../memory/index.ts';
import reviewPlugin from '../index.ts';

let cleanup: (() => Promise<void> | void) | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await cleanup?.();
  cleanup = undefined;
});

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'review-insight-inbound-'));
  const storage = createStorageService({ baseDir: dir, dataLocalDir: dir });
  const disposeStorage = () => { storage.dispose(); rmSync(dir, { recursive: true, force: true }); };
  cleanup = disposeStorage;
  const report = await storage.migrations.runAll();
  expect(report.success).toBe(true);
  expect(report.error).toBeNull();
  const settings = createSettingsService({
    db: () => storage.database('mistakes'), secureStore: () => null,
    secrets: { isSensitiveKey: () => false },
  });
  const host = await createTestHost({
    plugins: [pathsPlugin, vfsReposPlugin, notesPlugin, memoryPlugin, reviewPlugin],
    provide: { storage, settings, log: {
      write: vi.fn(),
      logger: (target: string) => ({ target, error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn() }),
    } }, app: { dataDir: dir },
  });
  cleanup = async () => { try { await host.dispose(); } finally { disposeStorage(); } };
  // Create through the real command and L17/L11 owners, without a parallel SQL seed.
  await host.invoke('insight_create_draft', { input: {
    title: 'inbound card', situation: '', stuck_point: '', turning_point: 'turn',
    rule: 'rule', validity_conditions: '', ownership: 'guided', evidence: [],
  } });
  let id = 0;
  const invoke = (argsJson: string) => host.runtime.dispatchInvoke({
    id: String(++id), cmd: 'insight_list', argsJson,
    // A conflicting old projection detects accidental fallback to args.
    args: { status: 'unknown', limit: 0, offset: 17 },
    source: { window: 'main', webview: 'main' },
  });
  return { invoke, db: storage.database('vfs') };
}

describe('WP-159 insight_list argsJson → real memory → SQLite', () => {
  it('keeps adjacent signed i64 tokens and extrema exact in both SQL branches', async () => {
    const { invoke, db } = await setup();
    const all = vi.spyOn(db, 'all'); // Call-through only: every query reaches real SQLite.
    for (const status of [null, 'active']) {
      const query = expect.objectContaining({ name: status === null ? 'memory.insight.list' : 'memory.insight.listByStatus' });
      const cases = [
        ['9007199254740992', '9007199254740992', 500, 0],
        ['9007199254740993', '9007199254740993', 500, 0],
        ['9223372036854775807', '9223372036854775807', 500, 0],
        ['-9007199254740992', '-9007199254740992', -9007199254740992n, 1],
        ['-9007199254740993', '-9007199254740993', -9007199254740993n, 1],
        ['-9223372036854775808', '-9223372036854775808', -9223372036854775808n, 1],
      ] as const;
      for (const [limit, offset, boundLimit, length] of cases) {
        const result = await invoke(`{"status":${JSON.stringify(status)},"limit":${limit},"offset":${offset}}`);
        expect(result.kind).toBe('ok');
        if (result.kind !== 'ok') throw new Error('Expected successful insight_list');
        expect(result.value).toHaveLength(length);
        // Empty high-offset pages alone cannot prove precision: check the actual binding.
        expect(all).toHaveBeenLastCalledWith(query,
          status === null ? [boundLimit, BigInt(offset)] : [status, boundLimit, BigInt(offset)]);
      }
    }
  });

  it('preserves missing/null defaults and explicit zero at the raw command boundary', async () => {
    const { invoke, db } = await setup();
    const all = vi.spyOn(db, 'all');
    for (const text of ['{}', '{"status":null,"limit":null,"offset":null}']) {
      const result = await invoke(text);
      expect(result).toMatchObject({ kind: 'ok', value: [{ title: 'inbound card', current_revision: { rule: 'rule' } }] });
      expect(all).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'memory.insight.list' }), [100, 0]);
    }
    expect(await invoke('{"limit":0,"offset":0}')).toEqual({ kind: 'ok', value: [] });
    expect(all).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'memory.insight.list' }), [0, 0]);
  });

  it('returns original Database SQL errors through the real command boundary', async () => {
    const { invoke, db } = await setup();
    // Fault injection on this disposable migrated database, not a replaced provider.
    db.exec('ALTER TABLE insights RENAME COLUMN title TO unavailable_title');
    for (const status of [null, 'active']) {
      expect(await invoke(`{"status":${JSON.stringify(status)},"limit":1,"offset":-9223372036854775808}`))
        .toEqual({ kind: 'err', error: { error_type: 'Database', message: 'no such column: title', details: null } });
    }
    db.exec('ALTER TABLE insights RENAME TO unavailable_insights');
    for (const status of [null, 'active']) {
      expect(await invoke(`{"status":${JSON.stringify(status)},"limit":9223372036854775807,"offset":9007199254740993}`))
        .toEqual({ kind: 'err', error: { error_type: 'Database', message: 'no such table: insights', details: null } });
    }
  });
});

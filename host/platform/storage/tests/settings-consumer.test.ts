import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSettingsStore } from '../../settings/index.ts';
import { createStorageService } from '../service.ts';

// F4 settings 直接使用 Rust 的 `?1 ?2 ?3` SQL：验证本执行器的编号参数绑定（含重复引用）对真实消费方可用。
describe('numbered ?NNN placeholders with a real consumer (host/platform/settings)', () => {
  it('settings store round-trips through the mistakes database', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-set-'));
    const s = createStorageService({ baseDir: dir, dataLocalDir: dir });
    try {
      const db = s.database('mistakes');
      db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)');
      const store = createSettingsStore({ db: () => db, secureStore: () => null, isSensitiveKey: () => false, now: () => '2026-11-03T00:00:00+00:00' });
      store.save('a.x', '1');
      store.save('a.y', '2');
      store.save('a.x', '3');
      expect(store.get('a.x')).toBe('3');
      expect(store.listByPrefix('a.').map((r) => r.key).sort()).toEqual(['a.x', 'a.y']);
      expect(store.deleteByPrefix('a.')).toBe(2);
      expect(store.get('a.y')).toBeNull();
      expect(db.get('SELECT ?2 AS b, ?1 AS a, ?2 AS b2', ['A', 'B'])).toEqual({ b: 'B', a: 'A', b2: 'B' });
    } finally {
      s.dispose();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('large_setting_upsert_preserves_rowid_and_integrity', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-set-large-'));
    const s = createStorageService({ baseDir: dir, dataLocalDir: dir });
    try {
      const db = s.database('mistakes');
      db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)');
      const store = createSettingsStore({ db: () => db, secureStore: () => null, isSensitiveKey: () => false, now: () => '2026-11-03T00:00:00+00:00' });
      const key = 'builtin_model_profiles_snapshot';

      store.save(key, 'a'.repeat(29_081));
      const originalRowid = db.pluck<number>('SELECT rowid FROM settings WHERE key = ?', [key]);

      for (let iteration = 0; iteration < 64; iteration++) {
        store.save(key, iteration % 2 === 0 ? 'b'.repeat(49_186) : 'c'.repeat(29_081));
        db.checkpoint('TRUNCATE');
      }

      expect(db.pluck<number>('SELECT rowid FROM settings WHERE key = ?', [key])).toBe(originalRowid);
      expect(db.pluck('PRAGMA integrity_check')).toBe('ok');
    } finally {
      s.dispose();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

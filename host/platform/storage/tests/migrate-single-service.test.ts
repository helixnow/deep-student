import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStorageService } from '../service.ts';

let base: string;
beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-migrate-single-'));
});
afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe('migrations.migrateSingle (public single-database seam)', () => {
  it('migrates only the requested database, reentrant, with audit disabled', async () => {
    const storage = createStorageService({ baseDir: base, dataLocalDir: base, auditDbPath: null });
    try {
      const first = await storage.migrations.migrateSingle('mistakes');
      expect(first).toMatchObject({ id: 'mistakes', success: true, error: null });
      expect(first.appliedCount).toBeGreaterThan(0);
      expect(first.toVersion).toBeGreaterThan(20260130);
      expect(storage.migrations.currentVersion('mistakes')).toBe(first.toVersion);
      expect(storage.migrations.needsMigration('mistakes')).toBe(false);

      // 单库迁移不打开/创建其它核心库。
      expect(fs.existsSync(storage.pathOf('vfs'))).toBe(false);
      expect(fs.existsSync(storage.pathOf('chat_v2'))).toBe(false);
      expect(fs.existsSync(storage.pathOf('llm_usage'))).toBe(false);
      // `with_audit_db(None)`：不写审计库。
      expect(fs.existsSync(path.join(storage.locations.activeDir, 'databases', 'audit.db'))).toBe(false);

      // 第二次调用仍走真实 verifier/fingerprint，且无待应用迁移。
      const second = await storage.migrations.migrateSingle('mistakes');
      expect(second).toMatchObject({ id: 'mistakes', success: true, appliedCount: 0, error: null });
      expect(second.toVersion).toBe(first.toVersion);
    } finally {
      storage.dispose();
    }
  });

  it('propagates migration errors instead of returning a synthetic report', async () => {
    const storage = createStorageService({ baseDir: base, dataLocalDir: base, auditDbPath: null });
    try {
      const mistakes = storage.pathOf('mistakes');
      fs.mkdirSync(path.dirname(mistakes), { recursive: true });
      fs.writeFileSync(mistakes, 'not a sqlite database');
      await expect(storage.migrations.migrateSingle('mistakes')).rejects.toThrow();
    } finally {
      storage.dispose();
    }
  });
});

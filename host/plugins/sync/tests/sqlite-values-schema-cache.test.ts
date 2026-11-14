import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createStorageService } from '../../../platform/storage/service.ts';
import { tableInfo } from '../repository/sqlite-values.ts';

it('does not reuse schema metadata cached through a long-lived root handle across transactions', () => {
  const root = mkdtempSync(join(tmpdir(), 'sync-schema-cache-'));
  const storage = createStorageService({ baseDir: root, dataLocalDir: root });
  const db = storage.openFile(':memory:', { profile: 'plain', label: 'schema-cache' });
  try {
    db.exec('CREATE TABLE t (a TEXT)');
    // A root DatabaseHandle reports inTransaction=true during this transaction, but it is
    // not a per-transaction scope: caching on it would leak into the next transaction.
    db.transaction(() => {
      expect(tableInfo(db, 't').map(column => column.name)).toEqual(['a']);
    });
    db.exec('ALTER TABLE t ADD COLUMN b TEXT');
    db.transaction(() => {
      expect(tableInfo(db, 't').map(column => column.name)).toEqual(['a', 'b']);
    });
  } finally {
    storage.close(db);
    storage.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

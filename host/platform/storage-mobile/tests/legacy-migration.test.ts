import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { Connection } from '../../storage/connection.ts';
import { PROFILES } from '../../storage/profiles.ts';
import { Runner } from '../../storage/migration/refinery-core.ts';
import type { MobileConnection } from '../connection.ts';
import { migrateMobileDatabase, migrationsFromSources } from '../migrations.ts';

it('upgrades a legacy VFS schema with existing sync columns and no refinery history', () => {
  const dir = join(import.meta.dirname, '../../../../resources/app/migrations/vfs');
  const sources = Object.fromEntries(readdirSync(dir).filter(name => name.endsWith('.sql')).map(name => [name, readFileSync(join(dir, name), 'utf8')]));
  const conn = new Connection(':memory:', { label: 'legacy-vfs', profile: PROFILES.plain });
  try {
    const migrations = migrationsFromSources(sources);
    new Runner(migrations, { target: { kind: 'Version', version: 20260201 } }).run(conn);
    conn.exec(`DROP TABLE refinery_schema_history; CREATE TABLE vfs_schema_history(version INTEGER);
      CREATE TABLE notes_schema_history(version INTEGER);`);
    // A partially applied later ALTER must skip the existing column but still
    // create its other columns/indexes and run its data migration.
    conn.exec(`ALTER TABLE files ADD COLUMN processing_status TEXT DEFAULT 'pending';`);
    const result = migrateMobileDatabase('vfs', conn as unknown as MobileConnection, sources);
    expect(result.success, result.error ?? '').toBe(true);
    expect(conn.pluck("SELECT COUNT(*) FROM pragma_table_info('resources') WHERE name='device_id'")).toBe(1);
    expect(conn.pluck('SELECT checksum FROM refinery_schema_history WHERE version=20260201')).toBe(migrations.find(m => m.version === 20260201)!.checksum.toString());
    expect(migrateMobileDatabase('vfs', conn as unknown as MobileConnection, sources).success).toBe(true);
  } finally { conn.close(); }
});

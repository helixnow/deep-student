// Browser schema helpers. All SQL for the database wrapper lives under repository/.

import { defineQuery, type SqlExecutor } from '../../../platform/storage/api.ts';

export const schemaVersion = defineQuery<never, number>(
  'SELECT COALESCE(MAX(version), 0) FROM refinery_schema_history',
  { name: 'browser.schema.version' },
);
export const foreignKeys = defineQuery<never, number>(
  'PRAGMA foreign_keys',
  { name: 'browser.schema.foreignKeys' },
);

/** `BrowserDatabase::get_schema_version`: a broken history table reads as 0. */
export function readSchemaVersion(conn: SqlExecutor): number {
  try { return conn.pluck<number>(schemaVersion) ?? 0; }
  catch { return 0; }
}

export function foreignKeysEnabled(conn: SqlExecutor): boolean {
  return conn.pluck<number>(foreignKeys) === 1;
}

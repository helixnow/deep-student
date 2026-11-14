import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { defineQuery } from '../../../platform/storage/query.ts';

const getValue = defineQuery<[string], { value: string }>(
  'SELECT value FROM memory_config WHERE key = ?1', { name: 'memory.config.get' });
const setValue = defineQuery<[string, string]>(
  "INSERT OR REPLACE INTO memory_config (key, value, updated_at) VALUES (?1, ?2, datetime('now'))",
  { name: 'memory.config.set' });

export function getConfigValue(db: SqlExecutor, key: string): string | null {
  // Rust query_row(...).ok(): query/conversion failures are intentionally absent values.
  try {
    const value = db.get(getValue, [key])?.value;
    return typeof value === 'string' && value.length > 0 ? value : null;
  } catch (error) {
    return null;
  }
}
export function setConfigValue(db: SqlExecutor, key: string, value: string): void {
  db.run(setValue, [key, value]);
}

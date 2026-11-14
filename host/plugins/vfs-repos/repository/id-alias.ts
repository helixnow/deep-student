import { logWarn } from './logger.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { IdAliasRepository } from '../api.ts';

export function tableExists(conn: SqlExecutor, tableName: string): boolean {
  try {
    return Boolean(conn.pluck<number>("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)", [tableName]));
  } catch (error) {
    throw new Error(`检查快照表是否存在失败: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

export function resolveAliasWithLookup(tableName: string, recordId: string, lookup: (id: string) => string | null): string {
  let current = recordId;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) {
      logWarn(`[sync] ID 别名存在循环，降级使用原始 record_id: ${tableName}.${recordId}`);
      return recordId;
    }
    seen.add(current);
    const next = lookup(current);
    if (next === null) return current;
    current = next;
  }
}

export function resolvePersistedIdAlias(conn: SqlExecutor, tableName: string, recordId: string): string {
  if (!tableExists(conn, '__sync_id_aliases')) return recordId;
  return resolveAliasWithLookup(tableName, recordId, current => {
    try {
      return conn.pluck<string>('SELECT canonical_id FROM __sync_id_aliases WHERE table_name = ?1 AND remote_id = ?2', [tableName, current]) ?? null;
    } catch (error) {
      throw new Error(`读取 ID 别名失败: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  });
}

export const idAliasRepository: IdAliasRepository = { tableExists, resolveAliasWithLookup, resolvePersistedIdAlias };

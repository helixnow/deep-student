/** commands_sync.rs:183-323: validate RowSync registry against persisted triggers. */
import { fs } from '../src/local-runtime.ts';
import type { StorageService, CoordinatedDatabaseName, DatabaseHandle, SqlExecutor } from '../../../platform/storage/api.ts';
import { CommandError } from '../../../kernel/api.ts';
import { rustTrim } from '../../../platform/util/index.ts';
import { syncClassificationRegistry, changeLogTriggerExempt } from '../src/classification.ts';

type TriggerEvent = 'insert' | 'update' | 'delete';
const events: readonly TriggerEvent[] = ['insert', 'update', 'delete'];
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

export function triggerEvent(sql: string): TriggerEvent | null {
  const tokens = rustTrim(sql).split(/\p{White_Space}+/u).map(token => token.replace(/[a-z]/g, char => char.toUpperCase()));
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === 'BEGIN') return null;
    let event: string | undefined;
    if (token === 'BEFORE' || token === 'AFTER') event = tokens[++index];
    else if (token === 'INSTEAD') {
      if (tokens[++index] !== 'OF') continue;
      event = tokens[++index];
    } else continue;
    if (event === 'INSERT') return 'insert';
    if (event === 'UPDATE') return 'update';
    if (event === 'DELETE') return 'delete';
    return null;
  }
  return null;
}

function inspectDatabase(db: SqlExecutor, name: string, issues: string[]): void {
  let tableRows: { name: string }[];
  try {
    tableRows = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
  } catch (error) { throw new CommandError(`同步预检读取表列表失败 ${name}: ${message(error)}`); }
  const tables = new Set(tableRows.filter(row => typeof row.name === 'string').map(row => row.name));
  const expected = new Set(syncClassificationRegistry()
    .filter(entry => entry.database === name && entry.category === 'RowSync' && tables.has(entry.table_name))
    .map(entry => entry.table_name));
  if (expected.size > 0 && !tables.has('__change_log')) {
    issues.push(`${name}.__change_log 缺少 __change_log 表`);
    return;
  }
  let triggers: { name: string; tbl_name: string; sql: string }[];
  try {
    triggers = db.all<{ name: string; tbl_name: string; sql: string }>(
      "SELECT name, tbl_name, COALESCE(sql, '') AS sql FROM sqlite_master WHERE type='trigger' AND sql LIKE '%__change_log%'",
    );
  } catch (error) { throw new CommandError(`同步预检读取触发器失败 ${name}: ${message(error)}`); }
  const ops = new Map<string, Set<TriggerEvent>>();
  for (const row of triggers) {
    if (typeof row.name !== 'string' || typeof row.tbl_name !== 'string' || typeof row.sql !== 'string') continue;
    if (!tables.has(row.tbl_name)) continue;
    if (!expected.has(row.tbl_name)) {
      issues.push(`${name}.${row.tbl_name} 存在 __change_log 触发器但 registry 不是 RowSync: ${row.name}`);
      continue;
    }
    const lower = row.name.replace(/[A-Z]/g, char => char.toLowerCase());
    const op = triggerEvent(row.sql) ?? events.find(event => lower.endsWith(`_${event}`));
    if (op !== undefined && op !== null) {
      const set = ops.get(row.tbl_name) ?? new Set<TriggerEvent>();
      set.add(op); ops.set(row.tbl_name, set);
    }
  }
  for (const table of expected) {
    for (const required of events) {
      if (changeLogTriggerExempt(name, table, required)) continue;
      if (!ops.get(table)?.has(required)) issues.push(`${name}.${table} 缺少 __change_log ${required} 触发器`);
    }
  }
}

export function validateSyncRegistryDrift(storage: StorageService): void {
  const names: readonly CoordinatedDatabaseName[] = ['vfs', 'llm_usage', 'chat_v2', 'mistakes'];
  const issues: string[] = [];
  for (const name of names) {
    const path = storage.pathOf(name);
    if (!fs.existsSync(path)) continue;
    let db: DatabaseHandle;
    try { db = storage.openFile(path, { profile: 'plain' }); }
    catch (error) { throw new CommandError(`同步预检无法打开数据库 ${name}: ${message(error)}`); }
    try { inspectDatabase(db, name, issues); }
    finally { storage.close(db); }
  }
  if (issues.length > 0) throw new CommandError(`同步预检失败：检测到 registry/触发器漂移。${issues.join('；')}`);
}

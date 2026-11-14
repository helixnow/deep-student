import { DatabaseSync } from 'node:sqlite';
import { firstDifference, normalize, stringifyExact } from './json.mjs';

const quote = name => `"${name.replaceAll('"', '""')}"`;

// Read-only fixture copy. Include schema and internal tables such as sqlite_sequence:
// an empty application table does not imply that its next generated ID is unchanged.
export function snapshot(filename, contract = {}) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    db.exec('BEGIN');
    const schema = db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
    const tables = schema.filter(item => item.type === 'table');
    const result = {};
    for (const { name, sql } of tables) {
      const columns = db.prepare(`PRAGMA table_info(${quote(name)})`).all();
      const primary = columns.filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk).map(c => c.name);
      const order = primary.length ? primary : columns.map(c => c.name);
      const stmt = db.prepare(`SELECT * FROM ${quote(name)} ORDER BY ${order.map(quote).join(',')}`);
      stmt.setReadBigInts(true);
      const records = stmt.all().map(row => {
        const types = Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
          value === null ? 'null' : value instanceof Uint8Array ? 'blob'
            : typeof value === 'bigint' ? 'integer' : typeof value === 'number' ? 'real' : 'text']));
        const value = Object.fromEntries(Object.entries(row).map(([k, v]) => [k,
          v instanceof Uint8Array ? { sqliteBlobHex: Buffer.from(v).toString('hex') } : v]));
        return { values: normalize(value, contract[name]?.volatile ?? []),
          types: normalize(types, contract[name]?.volatile ?? []) };
      });
      if (!primary.length) records.sort((a, b) => {
        const left = stringifyExact(a), right = stringifyExact(b);
        return left < right ? -1 : left > right ? 1 : 0;
      });
      result[name] = { sql, primaryKey: primary, rows: records.map(row => row.values), storageClasses: records.map(row => row.types) };
    }
    const metadata = {
      userVersion: db.prepare('PRAGMA user_version').get().user_version,
      applicationId: db.prepare('PRAGMA application_id').get().application_id,
    };
    db.exec('COMMIT');
    return { schema, metadata, tables: result };
  } finally { db.close(); }
}

export function databaseChanges(before, after) {
  const changes = {};
  for (const key of ['schema', 'metadata']) {
    if (firstDifference(before[key], after[key])) changes[key] = { before: before[key], after: after[key] };
  }
  const tables = {};
  for (const name of [...new Set([...Object.keys(before.tables), ...Object.keys(after.tables)])].sort()) {
    if (firstDifference(before.tables[name], after.tables[name])) tables[name] = { before: before.tables[name] ?? null, after: after.tables[name] ?? null };
  }
  if (Object.keys(tables).length) changes.tables = tables;
  return changes;
}

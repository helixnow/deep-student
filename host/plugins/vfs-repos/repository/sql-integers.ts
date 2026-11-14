/** Exact SQLite INTEGER (Rust i64) reads for columns that may exceed 2^53, e.g. index generations. */
import { defineQuery, type Query, type Row, type SqlParams, type SqlValue } from '../../../platform/storage/api.ts';

/** Same SQL, but every INTEGER column is read as bigint so no i64 is rounded through IEEE-754. */
export function safeIntegerQuery(sql: string, name: string): Query<SqlParams, Row> {
  return defineQuery<SqlParams, Row>(sql, { name, options: { safeIntegers: true } });
}

/** i64 as number when exactly representable, else bigint; null for non-integers. */
export function exactInteger(value: SqlValue | undefined): number | bigint | null {
  if (typeof value === 'bigint') return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  return null;
}

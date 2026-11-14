/**
 * `dstu-storage/src/migration/verifier.rs::MigrationVerifier`：迁移后验证表/列/索引/烟测查询。
 * 失败文案与 Rust 完全一致。
 */
import type { SqlParams } from '../api.ts';
import type { MigrationDef } from './definitions.ts';
import { MigrationError, errorText } from './errors.ts';

/** 契约校验实际用到的连接能力（只读查询）。 */
export interface VerifierConnection {
  get<R>(sql: string, params?: SqlParams): R | undefined;
  pluck<T>(sql: string, params?: SqlParams): T | undefined;
  all<R>(sql: string, params?: SqlParams): R[];
}

function dbError(error: unknown): MigrationError {
  return MigrationError.database(errorText(error), error);
}

function failed(def: MigrationDef, reason: string): MigrationError {
  return new MigrationError({ kind: 'VerificationFailed', version: def.refineryVersion >>> 0, reason });
}

export class MigrationVerifier {
  static verify(conn: VerifierConnection, def: MigrationDef): void {
    for (const table of def.expectedTables) {
      if (!MigrationVerifier.tableExists(conn, table)) throw failed(def, `Table '${table}' not found`);
    }
    for (const [table, column] of def.expectedColumns) {
      if (!MigrationVerifier.columnExists(conn, table, column)) {
        throw failed(def, `Column '${table}.${column}' not found`);
      }
    }
    for (const index of def.expectedIndexes) {
      if (!MigrationVerifier.indexExists(conn, index)) throw failed(def, `Index '${index}' not found`);
    }
    for (const query of def.expectedQueries) {
      try {
        MigrationVerifier.queryExecutes(conn, query);
      } catch (error) {
        throw failed(def, `Query smoke test failed '${MigrationVerifier.shortenQuery(query)}': ${errorText(error)}`);
      }
    }
  }

  /**
   * `shorten_query`：超过 96 **字节**截断为前 96 字节 + `...`。Rust 按字节切片，若第 96 字节落在
   * 多字节字符中间会 panic；这里退到前一个字符边界（现有契约查询均为 ASCII，不会触发）。
   */
  static shortenQuery(query: string): string {
    const MAX_LEN = 96;
    const bytes = new TextEncoder().encode(query);
    if (bytes.length <= MAX_LEN) return query;
    let end = MAX_LEN;
    // RUST-FIX(RF-W14-shorten-query-char-boundary): `&query[..MAX_LEN]` panics off a char boundary; back off to one.
    while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
    return `${new TextDecoder().decode(bytes.subarray(0, end))}...`;
  }

  private static tableExists(conn: VerifierConnection, table: string): boolean {
    try {
      return Number(conn.pluck("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?", [table])) > 0;
    } catch (error) {
      throw dbError(error);
    }
  }

  /** `PRAGMA table_info({table})`（未加引号，与 Rust 相同）。 */
  private static columnExists(conn: VerifierConnection, table: string, column: string): boolean {
    let rows: Array<{ name: unknown }>;
    try {
      rows = conn.all<{ name: unknown }>(`PRAGMA table_info(${table})`);
    } catch (error) {
      throw dbError(error);
    }
    return rows.some((row) => typeof row.name === 'string' && row.name === column);
  }

  private static indexExists(conn: VerifierConnection, index: string): boolean {
    try {
      return Number(conn.pluck("SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?", [index])) > 0;
    } catch (error) {
      throw dbError(error);
    }
  }

  /**
   * prepare + 取第一行（只要能开始迭代即可）。用 `get`（单步后 reset）而非 `iterate`：
   * 未迭代完的 better-sqlite3 迭代器会让连接保持 busy。契约查询均为 SELECT。
   */
  private static queryExecutes(conn: VerifierConnection, query: string): void {
    try {
      conn.get(query);
    } catch (error) {
      throw dbError(error);
    }
  }
}

/** 移植 dstu-storage/src/migration/verifier.rs 的 #[test]，并补充各失败分支的文案断言。 */
import { describe, expect, it } from 'vitest';
import { Connection } from '../connection.ts';
import { PROFILES } from '../profiles.ts';
import type { MigrationDef } from '../migration/definitions.ts';
import { MigrationError } from '../migration/errors.ts';
import { MigrationVerifier } from '../migration/verifier.ts';

const memory = () => new Connection(':memory:', { label: 'test', profile: PROFILES.plain });
const mk = (p: Partial<MigrationDef>): MigrationDef => ({
  refineryVersion: 20260130,
  name: 'init',
  sql: '',
  expectedTables: [],
  expectedColumns: [],
  expectedIndexes: [],
  expectedQueries: [],
  idempotent: false,
  ...p,
});
const reasonOf = (fn: () => void): string => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(MigrationError);
    const d = (e as MigrationError).detail;
    expect(d.kind).toBe('VerificationFailed');
    return d.kind === 'VerificationFailed' ? d.reason : '';
  }
  throw new Error('expected failure');
};

describe('MigrationVerifier (verifier.rs)', () => {
  it('verify_supports_query_smoke_tests', () => {
    const conn = memory();
    conn.exec('CREATE TABLE anki_cards (id TEXT PRIMARY KEY, text TEXT);');
    MigrationVerifier.verify(
      conn,
      mk({ expectedTables: ['anki_cards'], expectedColumns: [['anki_cards', 'text']], expectedQueries: ['SELECT text FROM anki_cards LIMIT 1'] }),
    );
    // 烟测后连接不残留进行中的语句
    conn.exec('DROP TABLE anki_cards');
    conn.close();
  });
  it('verify_fails_when_query_smoke_test_breaks', () => {
    const conn = memory();
    conn.exec('CREATE TABLE anki_cards (id TEXT PRIMARY KEY);');
    const reason = reasonOf(() =>
      MigrationVerifier.verify(conn, mk({ expectedTables: ['anki_cards'], expectedQueries: ['SELECT text FROM anki_cards LIMIT 1'] })),
    );
    expect(reason).toContain('Query smoke test failed');
    expect(reason).toBe("Query smoke test failed 'SELECT text FROM anki_cards LIMIT 1': Database error: no such column: text");
    conn.close();
  });
  it('reports missing table, column and index with Rust wording', () => {
    const conn = memory();
    conn.exec('CREATE TABLE t (a TEXT);');
    expect(reasonOf(() => MigrationVerifier.verify(conn, mk({ expectedTables: ['missing'] })))).toBe("Table 'missing' not found");
    expect(reasonOf(() => MigrationVerifier.verify(conn, mk({ expectedColumns: [['t', 'b']] })))).toBe("Column 't.b' not found");
    expect(reasonOf(() => MigrationVerifier.verify(conn, mk({ expectedIndexes: ['idx_x'] })))).toBe("Index 'idx_x' not found");
    try {
      MigrationVerifier.verify(conn, mk({ refineryVersion: 20260201, expectedTables: ['missing'] }));
    } catch (e) {
      expect((e as Error).message).toBe("Verification failed for migration 20260201: Table 'missing' not found");
    }
    conn.close();
  });
  it('shorten_query truncates at 96 bytes', () => {
    const q = 'SELECT ' + 'x'.repeat(200);
    expect(MigrationVerifier.shortenQuery(q)).toBe(q.slice(0, 96) + '...');
    expect(MigrationVerifier.shortenQuery('SELECT 1')).toBe('SELECT 1');
  });
});

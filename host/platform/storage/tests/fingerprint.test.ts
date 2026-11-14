import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Connection } from '../connection.ts';
import { PROFILES } from '../profiles.ts';
import { MigrationSet } from '../migration/definitions.ts';
import { computeSchemaFingerprint, filterCanonicalSchemaToScope, hashCanonicalSchema } from '../migration/fingerprint.ts';
import { loadSqlMigrations, Runner } from '../migration/refinery.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(here, '../../../../resources/app/migrations');
const FIXTURES = path.resolve(here, '../migration/__fixtures__');

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function setFromFiles(db: 'vfs' | 'chat_v2' | 'mistakes' | 'llm_usage'): MigrationSet {
  const ms = loadSqlMigrations(path.join(MIGRATIONS, db));
  return new MigrationSet(
    db,
    ms.map((m) => ({
      refineryVersion: m.version,
      name: m.name,
      sql: m.sql!,
      expectedTables: [],
      expectedColumns: [],
      expectedIndexes: [],
      expectedQueries: [],
      idempotent: false,
    })),
  );
}

describe('schema fingerprint matches the Rust build byte-for-byte', () => {
  const gold = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'rust-schema-fingerprints.json'), 'utf8')) as {
    databases: Record<string, { schema_version: number; fingerprint: string; canonical_schema: string }>;
  };
  for (const db of ['vfs', 'chat_v2', 'mistakes', 'llm_usage'] as const) {
    it(`${db}: fresh refinery migration to the recorded version reproduces the stored canonical schema and hash`, () => {
      const expected = gold.databases[db]!;
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-fp-'));
      tmpDirs.push(dir);
      const conn = new Connection(path.join(dir, `${db}.db`), { label: db, profile: { foreignKeys: true } });
      try {
        const migrations = loadSqlMigrations(path.join(MIGRATIONS, db));
        new Runner(migrations, { target: { kind: 'Version', version: expected.schema_version } }).run(conn);
        const set = setFromFiles(db);
        const fp = computeSchemaFingerprint(conn, set, expected.schema_version);
        expect(hashCanonicalSchema(expected.canonical_schema)).toBe(expected.fingerprint);
        expect(fp.canonicalSchema).toBe(expected.canonical_schema);
        expect(fp.hash).toBe(expected.fingerprint);
        expect(filterCanonicalSchemaToScope(fp.canonicalSchema, fp.scope)).toBe(fp.canonicalSchema);
      } finally {
        conn.close();
      }
    });
  }
});

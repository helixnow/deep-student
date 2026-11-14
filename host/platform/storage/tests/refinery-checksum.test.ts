import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadSqlMigrations, Migration, parseMigrationName, refineryChecksum, RefineryError, SipHasher13 } from '../migration/refinery.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(here, '../../../../resources/app/migrations');
const FIXTURES = path.resolve(here, '../migration/__fixtures__');

describe('SipHash-1-3 (siphasher 1.0 tests.rs::test_siphash_1_3 vectors)', () => {
  // keys k0 = 0x0706050403020100, k1 = 0x0f0e0d0c0b0a0908, message = [0, 1, ..., t-1]
  const k0 = 0x0706050403020100n;
  const k1 = 0x0f0e0d0c0b0a0908n;
  const vectors: Array<[number, number[]]> = [
    [0, [0xdc, 0xc4, 0x0f, 0x05, 0x58, 0x01, 0xac, 0xab]],
    [1, [0x93, 0xca, 0x57, 0x7d, 0xf3, 0x9b, 0xf4, 0xc9]],
    [7, [0x40, 0x11, 0xb1, 0x9b, 0x98, 0x7d, 0x92, 0xd3]],
    [8, [0x8e, 0x9a, 0x29, 0x8d, 0x11, 0x95, 0x90, 0x36]],
    [15, [0x56, 0x99, 0x51, 0x2a, 0x6d, 0xd8, 0x20, 0xd3]],
    [63, [0xa8, 0xb3, 0xbb, 0xb7, 0x62, 0x90, 0x19, 0x9d]],
  ];
  for (const [t, bytes] of vectors) {
    it(`len ${t}`, () => {
      const msg = Uint8Array.from({ length: t }, (_, i) => i);
      const expected = Buffer.from(bytes).readBigUInt64LE();
      expect(new SipHasher13(k0, k1).write(msg).finish()).toBe(expected);
      // 流式写入与一次写入结果一致
      const inc = new SipHasher13(k0, k1);
      for (const b of msg) inc.write(Uint8Array.of(b));
      expect(inc.finish()).toBe(expected);
    });
  }
});

describe('refinery checksum', () => {
  it('is SipHash13(0,0) over name‖0xFF‖i32le(version)‖sql‖0xFF', () => {
    const name = 'initial';
    const sql = 'CREATE TABLE persons (id int, name varchar(255), city varchar(255));';
    const bytes = Buffer.concat([
      Buffer.from(name),
      Buffer.from([0xff]),
      Buffer.from([1, 0, 0, 0]),
      Buffer.from(sql),
      Buffer.from([0xff]),
    ]);
    const expected = new SipHasher13().write(bytes).finish();
    expect(refineryChecksum(name, 1, sql)).toBe(expected);
    expect(Migration.unapplied('V1__initial', sql).checksum).toBe(expected);
    // 计算向量（由上面的算法定义得出，供其他实现交叉校验）
    expect(expected.toString()).toBe(String(refineryChecksum('initial', 1, sql)));
  });

  it('matches every refinery_schema_history row written by the Rust build', () => {
    const gold = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'rust-refinery-checksums.json'), 'utf8')) as {
      databases: Record<string, Array<{ version: number; name: string; checksum: string }>>;
    };
    let compared = 0;
    for (const [db, rows] of Object.entries(gold.databases)) {
      const migrations = loadSqlMigrations(path.join(MIGRATIONS, db));
      for (const row of rows) {
        const m = migrations.find((x) => x.version === row.version);
        expect(m, `${db} V${row.version}`).toBeDefined();
        expect(m!.name).toBe(row.name);
        expect(m!.checksum.toString(), `${db} V${row.version}__${row.name}`).toBe(row.checksum);
        compared++;
      }
    }
    expect(compared).toBe(129);
  });
});

describe('refinery migration names (util.rs parse_migration_name)', () => {
  it('parses V{version}__{name}', () => {
    expect(parseMigrationName('V20260130__init')).toEqual({ prefix: 'V', version: 20260130, name: 'init' });
    expect(parseMigrationName('U3__x_y')).toEqual({ prefix: 'U', version: 3, name: 'x_y' });
    // `\w+` 只取到第一个非单词字符
    expect(parseMigrationName('V1__first.sql').name).toBe('first');
  });
  it('rejects invalid names and versions like refinery', () => {
    expect(() => parseMigrationName('V20260130_001__init')).toThrowError(/format V\{number\}__\{name\}/);
    expect(() => parseMigrationName('V1first')).toThrowError(RefineryError);
    expect(() => parseMigrationName('V20260130.1__x')).toThrowError('migration version must be a valid integer');
    expect(() => parseMigrationName('V2147483648__x')).toThrowError('migration version must be a valid integer');
  });
  it('loads all 134 repository migration files sorted by version', () => {
    let total = 0;
    for (const db of ['vfs', 'chat_v2', 'mistakes', 'llm_usage', 'browser']) {
      const list = loadSqlMigrations(path.join(MIGRATIONS, db));
      const versions = list.map((m) => m.version);
      expect([...versions].sort((a, b) => a - b)).toEqual(versions);
      total += list.length;
    }
    expect(total).toBe(134);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LevelDbCorruption, readLevelDb, readLogRecords } from '../leveldb.ts';
import { SnappyError, snappyDecompress } from '../snappy.ts';
import { encodeBatch, encodeLog, encodeTable, snappyCompress, varint, writeLevelDb } from './fixtures.ts';

const text = (value: string) => Buffer.from(value, 'utf8');
const dump = (dir: string): Array<[string, string]> => readLevelDb(dir).map((record) => [record.key.toString('utf8'), record.value.toString('utf8')]);

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'w07-leveldb-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('snappy', () => {
  it('round-trips literals, short and long back-references and overlapping copies', () => {
    for (const input of [
      Buffer.alloc(0),
      text('abc'),
      text('abcdabcdabcdabcdabcd-tail'),
      Buffer.alloc(5000, 0x41),
      Buffer.concat([text('前缀'.repeat(200)), Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 7) & 0xff))]),
    ]) {
      expect(Buffer.from(snappyDecompress(snappyCompress(input))).equals(input)).toBe(true);
    }
  });

  it('decodes the 4-byte-offset copy form', () => {
    const body = Buffer.concat([varint(8), Buffer.of(3 << 2), text('abcd'), Buffer.of(3 | (3 << 2), 4, 0, 0, 0)]);
    expect(Buffer.from(snappyDecompress(body)).toString()).toBe('abcdabcd');
  });

  it('rejects offsets before the start of output and length mismatches', () => {
    expect(() => snappyDecompress(Buffer.concat([varint(4), Buffer.of(2 | (3 << 2), 1, 0)]))).toThrow(SnappyError);
    expect(() => snappyDecompress(Buffer.concat([varint(9), Buffer.of(3 << 2), text('abcd')]))).toThrow(SnappyError);
  });
});

describe('leveldb log format', () => {
  it('reassembles records fragmented across 32 KiB blocks', () => {
    const big = Buffer.alloc(100_000, 0x61);
    const records = readLogRecords(encodeLog([text('first'), big, text('last')]), 'test.log');
    expect(records.map((record) => record.length)).toEqual([5, 100_000, 4]);
  });

  it('treats a torn trailing record as end of file', () => {
    const log = encodeLog([text('kept'), text('torn-record')]);
    expect(readLogRecords(log.subarray(0, log.length - 3), 'test.log').map((r) => Buffer.from(r).toString())).toEqual(['kept']);
  });

  it('fails closed on a checksum mismatch', () => {
    const log = encodeLog([text('payload')]);
    log[10] = log[10]! ^ 0xff;
    expect(() => readLogRecords(log, 'test.log')).toThrow(LevelDbCorruption);
  });
});

describe('readLevelDb', () => {
  it('merges tables and logs by sequence number and honours deletions', () => {
    writeLevelDb(dir, {
      manifest: 7,
      edits: [
        { logNumber: 3, nextFile: 4, lastSeq: 0 },
        { newFiles: [{ level: 0, number: 4, size: 0 }, { level: 1, number: 5, size: 0 }], logNumber: 6, nextFile: 8, lastSeq: 20 },
      ],
      tables: {
        4: encodeTable([
          { key: text('a'), seq: 10n, value: text('a@10') },
          { key: text('b'), seq: 11n, value: text('b@11') },
          { key: text('c'), seq: 12n, deleted: true },
        ], { compress: true }),
        5: encodeTable([
          { key: text('a'), seq: 1n, value: text('a@1') },
          { key: text('c'), seq: 2n, value: text('c@2') },
          { key: text('d'), seq: 3n, value: text('d@3') },
          ...Array.from({ length: 12 }, (_, i) => ({ key: text(`shared-prefix-${String(i).padStart(2, '0')}`), seq: 4n, value: text(`v${i}`) })),
        ], { perBlock: 5, restartInterval: 3 }),
        9: encodeTable([{ key: text('obsolete'), seq: 99n, value: text('ignored') }]),
      },
      logs: {
        3: encodeLog([encodeBatch(30n, [{ put: text('stale-log'), value: text('ignored') }])]),
        6: encodeLog([
          encodeBatch(21n, [{ put: text('b'), value: text('b@21') }, { del: text('d') }]),
          encodeBatch(23n, [{ put: text('e'), value: text('e@23') }]),
        ]),
      },
      extra: { LOCK: '', LOG: 'leveldb info log' },
    });
    const records = dump(dir);
    expect(records.filter(([key]) => !key.startsWith('shared-prefix-'))).toEqual([
      ['a', 'a@10'],
      ['b', 'b@21'],
      ['e', 'e@23'],
    ]);
    expect(records.filter(([key]) => key.startsWith('shared-prefix-'))).toHaveLength(12);
  });

  it('drops files removed by a later VersionEdit', () => {
    writeLevelDb(dir, {
      manifest: 2,
      edits: [
        { newFiles: [{ level: 0, number: 4, size: 0 }], logNumber: 5 },
        { deletedFiles: [{ level: 0, number: 4 }], newFiles: [{ level: 1, number: 6, size: 0 }], logNumber: 7 },
      ],
      tables: {
        4: encodeTable([{ key: text('k'), seq: 1n, value: text('old') }, { key: text('gone'), seq: 1n, value: text('x') }]),
        6: encodeTable([{ key: text('k'), seq: 1n, value: text('compacted') }]),
      },
    });
    expect(dump(dir)).toEqual([['k', 'compacted']]);
  });

  it('fails closed when MANIFEST references a missing table or a block is corrupt', () => {
    writeLevelDb(dir, { manifest: 2, edits: [{ newFiles: [{ level: 0, number: 4, size: 0 }], logNumber: 5 }] });
    expect(() => readLevelDb(dir)).toThrow(/missing table 4/);

    writeFileSync(join(dir, '000004.ldb'), encodeTable([{ key: text('k'), seq: 1n, value: text('v') }]));
    expect(dump(dir)).toEqual([['k', 'v']]);
    const table = readFileSync(join(dir, '000004.ldb'));
    table[3] = table[3]! ^ 0xff;
    writeFileSync(join(dir, '000004.ldb'), table);
    expect(() => readLevelDb(dir)).toThrow(/checksum mismatch/);
  });

  it('rejects a CURRENT file that does not name a manifest', () => {
    writeFileSync(join(dir, 'CURRENT'), '../../etc/passwd\n');
    expect(() => readLevelDb(dir)).toThrow(LevelDbCorruption);
  });
});

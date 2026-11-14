import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeChromiumLocalStorage, decodeWebKitLocalStorage, LocalStorageFormatError, utf16leToString } from '../formats.ts';
import type { LevelDbRecord } from '../leveldb.ts';
import { chromiumKey, chromiumString, PRIORITY_ENTRIES, utf16le, writeWebKitLocalStorage } from './fixtures.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'w07-formats-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('WebKit ItemTable', () => {
  it('restores UTF-16LE code units exactly, including NUL, lone surrogates and long values', () => {
    const file = join(dir, 'tauri_localhost_0.localstorage');
    writeWebKitLocalStorage(file, PRIORITY_ENTRIES);
    expect(decodeWebKitLocalStorage(file)).toEqual(PRIORITY_ENTRIES);
  });

  it('accepts TEXT values written by older WebKit builds', () => {
    const file = join(dir, 'text.localstorage');
    writeWebKitLocalStorage(file, []);
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (p: string) => { exec(sql: string): void; close(): void } };
    const db = new DatabaseSync(file);
    db.exec("INSERT INTO ItemTable (key, value) VALUES ('dstu-theme-mode', 'dark')");
    db.close();
    expect(decodeWebKitLocalStorage(file)).toEqual([['dstu-theme-mode', 'dark']]);
  });

  it('rejects odd-length UTF-16 blobs, unknown schemas and non-SQLite files', () => {
    const odd = join(dir, 'odd.localstorage');
    writeWebKitLocalStorage(odd, [['k', Buffer.of(0x61, 0x00, 0x62)]]);
    expect(() => decodeWebKitLocalStorage(odd)).toThrow(LocalStorageFormatError);

    const other = join(dir, 'other.sqlite3');
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (p: string) => { exec(sql: string): void; close(): void } };
    const db = new DatabaseSync(other);
    db.exec('CREATE TABLE Items (k TEXT, v BLOB)');
    db.close();
    expect(() => decodeWebKitLocalStorage(other)).toThrow(/ItemTable/);

    const garbage = join(dir, 'garbage.localstorage');
    writeFileSync(garbage, Buffer.alloc(4096, 0x5a));
    expect(() => decodeWebKitLocalStorage(garbage)).toThrow();
  });

  it('utf16leToString handles values larger than the argument-spread chunk', () => {
    const value = '汉'.repeat(20_000);
    expect(utf16leToString(utf16le(value))).toBe(value);
  });
});

describe('Chromium localStorage records', () => {
  const origin = 'http://tauri.localhost';
  const record = (key: Buffer, value: Buffer): LevelDbRecord => ({ key, value });

  it('keeps only the requested origin and decodes both string encodings', () => {
    const records = [
      record(Buffer.from('VERSION'), Buffer.from('1')),
      record(Buffer.from(`META:${origin}`), Buffer.of(0x08, 0x01)),
      record(chromiumKey(origin, 'essay_draft_e1b2'), chromiumString('作文草稿😀')),
      record(chromiumKey(origin, 'i18nextLng', 'latin1'), chromiumString('zh-CN', 'latin1')),
      record(chromiumKey(origin, 'lone'), chromiumString('\uDC00')),
      record(chromiumKey('https://example.com', 'essay_draft_e1b2'), chromiumString('other origin')),
      record(chromiumKey(`${origin}:8080`, 'port'), chromiumString('other port')),
    ];
    expect(decodeChromiumLocalStorage(records, origin)).toEqual([
      ['essay_draft_e1b2', '作文草稿😀'],
      ['i18nextLng', 'zh-CN'],
      ['lone', '\uDC00'],
    ]);
  });

  it('returns nothing for an empty database and fails closed on unknown schema versions or prefixes', () => {
    expect(decodeChromiumLocalStorage([], origin)).toEqual([]);
    expect(() => decodeChromiumLocalStorage([record(chromiumKey(origin, 'k'), chromiumString('v'))], origin)).toThrow(/VERSION/);
    expect(() => decodeChromiumLocalStorage([record(Buffer.from('VERSION'), Buffer.from('2'))], origin)).toThrow(/VERSION/);
    expect(() => decodeChromiumLocalStorage([
      record(Buffer.from('VERSION'), Buffer.from('1')),
      record(chromiumKey(origin, 'k'), Buffer.of(7, 0x61)),
    ], origin)).toThrow(/编码前缀/);
  });
});

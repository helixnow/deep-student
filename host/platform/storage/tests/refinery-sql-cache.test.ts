import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadSqlMigrations, readMigrationSql, refineryChecksum } from '../migration/refinery.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(here, '../../../../resources/app/migrations');

const temps: string[] = [];
const pinnedCtimes = new Map<string, bigint>();
const realStatSync = fs.statSync;
afterEach(() => {
  vi.restoreAllMocks();
  pinnedCtimes.clear();
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w14-refinery-cache-'));
  temps.push(dir);
  return dir;
}

function migrationReads(spy: { mock: { calls: ReadonlyArray<readonly unknown[]> } }, dir: string): string[] {
  return spy.mock.calls.map((call) => String(call[0])).filter((file) => file.startsWith(dir)).map((file) => path.basename(file));
}

/**
 * Sets mtime and ctime of `file` to whole seconds, as a coarse-timestamp filesystem (or a file untouched for a
 * long time) would report them. `utimes` sets mtime; ctime cannot be set, so `fs.statSync` is wrapped to pin it.
 */
function pinTimes(file: string, seconds: number, ctimeSeconds = seconds): void {
  fs.utimesSync(file, seconds, seconds);
  pinnedCtimes.set(path.resolve(file), BigInt(ctimeSeconds) * 1_000_000_000n);
  if (vi.isMockFunction(fs.statSync)) return;
  vi.spyOn(fs, 'statSync').mockImplementation(((file: fs.PathLike, options?: fs.StatSyncOptions) => {
    const st = realStatSync(file, options);
    const ctimeNs = pinnedCtimes.get(path.resolve(String(file)));
    if (ctimeNs !== undefined && st !== undefined && 'ctimeNs' in st) st.ctimeNs = ctimeNs;
    return st;
  }) as typeof fs.statSync);
}

function statSignature(file: string): string {
  const st = fs.statSync(file, { bigint: true });
  return `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
}

/** An arbitrary whole second, so tests that fix the clock do not depend on when they run. */
const T = 1_700_000_000;

describe('loadSqlMigrations reads each migration file once per content', () => {
  it('repeat loads of an unchanged directory return equal migrations without re-reading any file', () => {
    // Files changed within the racy window are never cached, and a checkout may have just rewritten these.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_000);
    const first = loadSqlMigrations(path.join(MIGRATIONS, 'vfs'));
    const read = vi.spyOn(fs, 'readFileSync');
    const second = loadSqlMigrations(path.join(MIGRATIONS, 'vfs'));
    expect(migrationReads(read, MIGRATIONS)).toEqual([]);
    expect(second.map((m) => [m.version, m.name, m.checksum, m.sql])).toEqual(first.map((m) => [m.version, m.name, m.checksum, m.sql]));
    for (const migration of second) {
      expect(migration.sql).toBe(fs.readFileSync(path.join(MIGRATIONS, 'vfs', `V${migration.version}__${migration.name}.sql`), 'utf8'));
    }
  });

  it('returns fresh Migration objects each load (the runner mutates appliedOn)', () => {
    const [a] = loadSqlMigrations(path.join(MIGRATIONS, 'llm_usage'));
    const [b] = loadSqlMigrations(path.join(MIGRATIONS, 'llm_usage'));
    expect(a).not.toBe(b);
    a!.appliedOn = '2026-01-01T00:00:00Z';
    expect(b!.appliedOn).toBeUndefined();
  });

  it('a rewritten file is re-read even with the same size and the old mtime restored', () => {
    const dir = tempDir();
    const file = path.join(dir, 'V1__init.sql');
    fs.writeFileSync(file, 'CREATE TABLE a (id INTEGER);');
    fs.writeFileSync(path.join(dir, 'V2__more.sql'), 'CREATE TABLE b (id INTEGER);');
    // V2 stands for a file untouched for an hour, which must stay cached. V1's mtime is restored exactly, so only
    // its real ctime could tell the versions apart, and on a coarse filesystem both writes share it.
    pinTimes(path.join(dir, 'V2__more.sql'), Math.floor(Date.now() / 1000) - 3600);
    fs.utimesSync(file, 1_700_000_000, 1_700_000_000);
    const before = loadSqlMigrations(dir);
    expect(before[0]!.checksum).toBe(refineryChecksum('init', 1, 'CREATE TABLE a (id INTEGER);'));

    fs.writeFileSync(file, 'CREATE TABLE z (id INTEGER);');
    fs.utimesSync(file, 1_700_000_000, 1_700_000_000);
    expect(fs.statSync(file, { bigint: true }).mtimeNs).toBe(1_700_000_000_000_000_000n);
    const read = vi.spyOn(fs, 'readFileSync');
    const after = loadSqlMigrations(dir);
    expect(migrationReads(read, dir)).toEqual(['V1__init.sql']);
    expect(after[0]!.sql).toBe('CREATE TABLE z (id INTEGER);');
    expect(after[0]!.checksum).toBe(refineryChecksum('init', 1, 'CREATE TABLE z (id INTEGER);'));
    expect(after[1]!.checksum).toBe(before[1]!.checksum);
  });

  it.each([
    ['mtime moved, ctime unchanged', T + 1, T],
    ['mtime restored by utimes, only ctime moved', T, T + 1],
  ])('a trusted, cached entry is re-read once its file changes outside the racy window: %s', (_case, mtime, ctime) => {
    const dir = tempDir();
    const file = path.join(dir, 'V1__init.sql');
    vi.spyOn(Date, 'now').mockReturnValue((T + 3600) * 1000);
    fs.writeFileSync(file, 'CREATE TABLE a (id INTEGER);');
    fs.writeFileSync(path.join(dir, 'V2__more.sql'), 'CREATE TABLE b (id INTEGER);');
    pinTimes(file, T);
    pinTimes(path.join(dir, 'V2__more.sql'), T);
    const before = loadSqlMigrations(dir);
    expect(before[0]!.sql).toBe('CREATE TABLE a (id INTEGER);');
    const read = vi.spyOn(fs, 'readFileSync');
    expect(loadSqlMigrations(dir).map((m) => m.sql)).toEqual(before.map((m) => m.sql));
    expect(migrationReads(read, dir)).toEqual([]);

    fs.writeFileSync(file, 'CREATE TABLE z (id INTEGER);');
    pinTimes(file, mtime, ctime);
    const st = fs.statSync(file, { bigint: true });
    expect([st.size, st.mtimeNs, st.ctimeNs]).toEqual([BigInt('CREATE TABLE a (id INTEGER);'.length), BigInt(mtime) * 1_000_000_000n, BigInt(ctime) * 1_000_000_000n]);
    const after = loadSqlMigrations(dir);
    expect(migrationReads(read, dir)).toEqual(['V1__init.sql']);
    expect(after[0]!.sql).toBe('CREATE TABLE z (id INTEGER);');
    expect(after[0]!.checksum).toBe(refineryChecksum('init', 1, 'CREATE TABLE z (id INTEGER);'));
    expect(after[1]!.checksum).toBe(before[1]!.checksum);
  });

  it('added, removed and replaced files are picked up', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'V1__init.sql'), 'SELECT 1;');
    fs.writeFileSync(path.join(dir, 'V2__two.sql'), 'SELECT 2;');
    expect(loadSqlMigrations(dir).map((m) => m.version)).toEqual([1, 2]);

    fs.rmSync(path.join(dir, 'V2__two.sql'));
    fs.writeFileSync(path.join(dir, 'V3__three.sql'), 'SELECT 3;');
    expect(loadSqlMigrations(dir).map((m) => [m.version, m.sql])).toEqual([[1, 'SELECT 1;'], [3, 'SELECT 3;']]);

    fs.writeFileSync(path.join(dir, 'next.tmp'), 'SELECT 4;');
    fs.renameSync(path.join(dir, 'next.tmp'), path.join(dir, 'V1__init.sql'));
    expect(loadSqlMigrations(dir).map((m) => [m.version, m.sql])).toEqual([[1, 'SELECT 4;'], [3, 'SELECT 3;']]);
  });

  it('readMigrationSql resolves relative paths to the same cache entry and fails on a missing file like readFileSync', () => {
    const dir = tempDir();
    const file = path.join(dir, 'V1__init.sql');
    fs.writeFileSync(file, 'SELECT 1;');
    pinTimes(file, Math.floor(Date.now() / 1000) - 3600);
    expect(readMigrationSql(file)).toBe('SELECT 1;');
    const read = vi.spyOn(fs, 'readFileSync');
    expect(readMigrationSql(path.relative(process.cwd(), file))).toBe('SELECT 1;');
    expect(migrationReads(read, dir)).toEqual([]);
    fs.rmSync(file);
    expect(() => readMigrationSql(file)).toThrow(expect.objectContaining({ code: 'ENOENT' }));
  });
});

describe('readMigrationSql does not trust a stat signature taken within a timestamp tick of the write', () => {
  it.each([
    ['Linux coarse clock (4 ms tick)', 3],
    ['HFS+ / ext3 (1 s)', 999],
    ['FAT (2 s)', 1999],
  ])('a same-size rewrite with an identical stat signature is re-read: %s', (_fs, readDelayMs) => {
    const dir = tempDir();
    const file = path.join(dir, 'V1__init.sql');
    vi.spyOn(Date, 'now').mockReturnValue(T * 1000 + readDelayMs);
    fs.writeFileSync(file, 'CREATE TABLE a (id INTEGER);');
    pinTimes(file, T);
    const signature = statSignature(file);
    expect(loadSqlMigrations(dir)[0]!.sql).toBe('CREATE TABLE a (id INTEGER);');

    fs.writeFileSync(file, 'CREATE TABLE z (id INTEGER);');
    pinTimes(file, T);
    expect(statSignature(file)).toBe(signature);
    const read = vi.spyOn(fs, 'readFileSync');
    const [after] = loadSqlMigrations(dir);
    expect(migrationReads(read, dir)).toEqual(['V1__init.sql']);
    expect(after!.sql).toBe('CREATE TABLE z (id INTEGER);');
    expect(after!.checksum).toBe(refineryChecksum('init', 1, 'CREATE TABLE z (id INTEGER);'));
  });

  it.each([
    ['an old mtime restored by utimes, ctime inside the tick', T - 3600, T],
    ['mtime inside the tick, a ctime that writes do not move (no change time on the filesystem)', T, T - 3600],
  ])('either timestamp inside the tick keeps the file untrusted: %s', (_case, mtime, ctime) => {
    const dir = tempDir();
    const file = path.join(dir, 'V1__init.sql');
    vi.spyOn(Date, 'now').mockReturnValue(T * 1000 + 500);
    fs.writeFileSync(file, 'CREATE TABLE a (id INTEGER);');
    pinTimes(file, mtime, ctime);
    expect(readMigrationSql(file)).toBe('CREATE TABLE a (id INTEGER);');
    fs.writeFileSync(file, 'CREATE TABLE z (id INTEGER);');
    pinTimes(file, mtime, ctime);
    const read = vi.spyOn(fs, 'readFileSync');
    expect(readMigrationSql(file)).toBe('CREATE TABLE z (id INTEGER);');
    expect(migrationReads(read, dir)).toEqual(['V1__init.sql']);
  });

  it('text read inside the tick is not trusted later; the first read after the window is, and is then cached', () => {
    const dir = tempDir();
    const file = path.join(dir, 'V1__init.sql');
    const now = vi.spyOn(Date, 'now').mockReturnValue(T * 1000 + 500);
    fs.writeFileSync(file, 'CREATE TABLE a (id INTEGER);');
    pinTimes(file, T);
    expect(readMigrationSql(file)).toBe('CREATE TABLE a (id INTEGER);');
    fs.writeFileSync(file, 'CREATE TABLE z (id INTEGER);');
    pinTimes(file, T);

    now.mockReturnValue((T + 60) * 1000);
    const read = vi.spyOn(fs, 'readFileSync');
    expect(readMigrationSql(file)).toBe('CREATE TABLE z (id INTEGER);');
    expect(migrationReads(read, dir)).toEqual(['V1__init.sql']);
    now.mockReturnValue((T + 61) * 1000);
    expect(readMigrationSql(file)).toBe('CREATE TABLE z (id INTEGER);');
    expect(migrationReads(read, dir)).toEqual(['V1__init.sql']);
  });

  it('files last changed 10 s before the read are cached: repeat loads read nothing', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'V1__init.sql'), 'CREATE TABLE a (id INTEGER);');
    fs.writeFileSync(path.join(dir, 'V2__more.sql'), 'CREATE TABLE b (id INTEGER);');
    pinTimes(path.join(dir, 'V1__init.sql'), T);
    pinTimes(path.join(dir, 'V2__more.sql'), T);
    vi.spyOn(Date, 'now').mockReturnValue((T + 10) * 1000);
    const first = loadSqlMigrations(dir);
    const read = vi.spyOn(fs, 'readFileSync');
    for (let i = 0; i < 3; i++) {
      expect(loadSqlMigrations(dir).map((m) => [m.version, m.checksum, m.sql])).toEqual(first.map((m) => [m.version, m.checksum, m.sql]));
    }
    expect(migrationReads(read, dir)).toEqual([]);
  });
});

describe('readMigrationSql racy window edges', () => {
  it('a file changed exactly 3 s before the stat is still re-read; 1 ms later its signature is trusted and cached', () => {
    const dir = tempDir();
    const file = path.join(dir, 'V1__init.sql');
    const now = vi.spyOn(Date, 'now').mockReturnValue((T + 3) * 1000);
    fs.writeFileSync(file, 'SELECT 1;');
    pinTimes(file, T);
    expect(readMigrationSql(file)).toBe('SELECT 1;');
    fs.writeFileSync(file, 'SELECT 2;');
    pinTimes(file, T);
    const read = vi.spyOn(fs, 'readFileSync');
    expect(readMigrationSql(file)).toBe('SELECT 2;');
    expect(migrationReads(read, dir)).toEqual(['V1__init.sql']);

    now.mockReturnValue((T + 3) * 1000 + 1);
    expect(readMigrationSql(file)).toBe('SELECT 2;');
    expect(readMigrationSql(file)).toBe('SELECT 2;');
    expect(migrationReads(read, dir)).toEqual(['V1__init.sql', 'V1__init.sql']);
  });

  it('timestamps ahead of the local clock (a network share whose server clock runs fast) are never trusted', () => {
    const dir = tempDir();
    const file = path.join(dir, 'V1__init.sql');
    vi.spyOn(Date, 'now').mockReturnValue(T * 1000);
    fs.writeFileSync(file, 'SELECT 1;');
    pinTimes(file, T + 60);
    expect(readMigrationSql(file)).toBe('SELECT 1;');
    fs.writeFileSync(file, 'SELECT 2;');
    pinTimes(file, T + 60);
    const read = vi.spyOn(fs, 'readFileSync');
    expect(readMigrationSql(file)).toBe('SELECT 2;');
    expect(migrationReads(read, dir)).toEqual(['V1__init.sql']);
  });
});

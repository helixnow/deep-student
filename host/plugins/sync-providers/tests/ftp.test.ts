import './local-fs-fixture.ts';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { CloudStorageError } from '../src/errors.ts';
import {
  FTP_LIST_MAX_DIRS,
  FtpStorage,
  absolutePath,
  extractStatusCode,
  isMissingDirectoryError,
  isNotFoundError,
  joinPaths,
  parseDosLine,
  parseListEntry,
  parseMlsxLine,
  parsePosixLine,
  splitParentFilename,
  streamToFile,
  transferTimeoutMs,
  withRetry,
} from '../src/ftp.ts';
import { ensureDeclaredLenWithinBudget, MEMORY_GET_DEFAULT_BUDGET_BYTES } from '../src/traits.ts';
import { spawnFakeFtp, type FakeFtp } from './fake_ftp.ts';

const storage = (root = 'deep-student-sync'): FtpStorage => new FtpStorage(
  { host: 'localhost', port: 21, username: 'user', password: 'pass', useTls: false },
  root,
);

const tempDirs: string[] = [];
const ftpServers: FakeFtp[] = [];
afterEach(async () => {
  while (ftpServers.length > 0) await ftpServers.pop()!.close();
  while (tempDirs.length > 0) await rm(tempDirs.pop()!, { recursive: true, force: true });
});
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ftp-test-'));
  tempDirs.push(dir);
  return dir;
}

function fakeStorage(server: { host: string; port: number }, root = 'deep-student-sync', useTls = false): FtpStorage {
  return new FtpStorage({ host: server.host, port: server.port, username: 'user', password: 'pass', useTls }, root);
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  try { await promise; }
  catch (error) { return error as Error; }
  throw new Error('expected the operation to fail');
}

async function* chunksOf(data: Uint8Array, chunkSize = 4096): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < data.byteLength; offset += chunkSize) {
    yield data.subarray(offset, Math.min(offset + chunkSize, data.byteLength));
  }
}

describe('ftp.rs', () => {
  it('test_join_paths', () => {
    expect(joinPaths('root', 'file.txt')).toBe('root/file.txt');
    expect(joinPaths('root/', 'file.txt')).toBe('root/file.txt');
    expect(joinPaths('root', '/file.txt')).toBe('root/file.txt');
    expect(joinPaths('', 'file.txt')).toBe('file.txt');
    expect(joinPaths('root', '')).toBe('root');
    expect(joinPaths('', '')).toBe('');
  });

  it('test_remote_path', () => {
    const ftp = storage();
    expect(ftp.instanceBindingHint()).toBe('ftp|host=localhost|port=21|user=user|tls=false|root=deep-student-sync');
    expect(joinPaths('deep-student-sync', 'objects/basic/hello.txt')).toBe('deep-student-sync/objects/basic/hello.txt');
    expect(absolutePath('deep-student-sync/objects')).toBe('/deep-student-sync/objects');
    expect(absolutePath('')).toBe('/');
    expect(splitParentFilename('objects/basic/hello.txt')).toEqual(['objects/basic', 'hello.txt']);
    expect(splitParentFilename('hello.txt')).toEqual(['', 'hello.txt']);
  });

  it('test_pyftpdlib_not_retrievable_is_not_found', () => {
    const error = new CloudStorageError('FileSystem', 'FTP SIZE 失败：Invalid response: [550] 550 /missing/file.txt is not retrievable.');
    expect(isNotFoundError(error)).toBe(true);
  });

  it('test_not_found_whitelist_accepts_explicit_missing_messages', () => {
    for (const message of [
      'FTP SIZE 失败：Invalid response: [550] 550 No such file or directory.',
      'FTP MLSD 失败：Invalid response: [501] 501 No such directory.',
      'FTP CWD 失败：Invalid response: [550] 550 /a/b: No such file or directory',
      'FTP DELETE 失败：Invalid response: [550] 550 File not found.',
    ]) {
      expect(isNotFoundError(new CloudStorageError('FileSystem', message)), `应归类为 not-found: ${message}`).toBe(true);
    }
  });

  it('test_broad_not_found_substring_no_longer_matches', () => {
    for (const message of [
      'FTP DELETE 失败：object not found',
      'FTP CWD 失败：host not found',
      '连接失败：server not found in DNS',
      'FTP SIZE 失败：目标不存在',
    ]) {
      expect(isNotFoundError(new CloudStorageError('FileSystem', message)), `缺少状态码时不得归类为 not-found: ${message}`).toBe(false);
    }
  });

  it('test_unclassifiable_550_is_not_treated_as_missing', () => {
    for (const message of [
      'FTP DELETE 失败：Invalid response: [550] 550 Permission denied.',
      'FTP CWD 失败：Invalid response: [550] 550 Failed to change directory.',
      'FTP RM 失败：Invalid response: [550] 550 Requested action not taken.',
    ]) {
      expect(isNotFoundError(new CloudStorageError('FileSystem', message)), `无法归类的 550 不得当作 not-found: ${message}`).toBe(false);
    }
  });

  it('explicit_missing_parent_directory_cwd_is_treated_as_absent', () => {
    for (const message of [
      'FTP CWD 失败：Invalid response: [550] 550 /root/data_governance/assets: No such file or directory',
      'FTP CWD 失败：Invalid response: [550] 550 Directory not found.',
      'FTP CWD 失败：Invalid response: [550] 550 410 Gone.',
    ]) {
      expect(isMissingDirectoryError(new CloudStorageError('FileSystem', message)), `expected ${message} to be treated as a missing directory`).toBe(true);
    }
  });

  it('test_extract_status_code', () => {
    expect(extractStatusCode('invalid response: [550] 550 no such file')).toBe(550);
    expect(extractStatusCode('ftp cwd 失败：550 no such directory.')).toBe(550);
    expect(extractStatusCode('object not found')).toBeNull();
    expect(extractStatusCode('connection reset')).toBeNull();
  });

  it('ambiguous_or_permission_denied_cwd_is_still_an_error', () => {
    for (const message of [
      'FTP CWD 失败：Invalid response: [550] 550 Failed to change directory.',
      'FTP CWD 失败：Invalid response: [550] 550 Permission denied.',
      'FTP CWD 失败：Invalid response: [550] 550 Requested action not taken.',
      'FTP CWD 失败：Invalid response: [450] 450 No such directory.',
      'FTP CWD 失败：Invalid response: [450] 450 /root/550: No such directory.',
    ]) {
      expect(isMissingDirectoryError(new CloudStorageError('FileSystem', message)), `expected ambiguous or non-550 CWD failure to remain an error: ${message}`).toBe(false);
    }
  });

  it('parses MLSD, POSIX and DOS listing lines', () => {
    const mlsd = parseMlsxLine('type=file;size=1024;modify=20200101120000; name.txt');
    expect(mlsd).toEqual({ name: 'name.txt', isDir: false, size: 1024, modified: Date.UTC(2020, 0, 1, 12, 0, 0) });
    const mlsdDir = parseMlsxLine('type=dir;modify=20200101120000; sub');
    expect(mlsdDir?.isDir).toBe(true);
    expect(parseMlsxLine('type=file;size=not-a-number; x')).toBeNull();
    expect(parseMlsxLine('type=socket; x')).toBeNull();

    const posix = parsePosixLine('-rw-r--r-- 1 user group 1234 Nov 5 2019 example.txt');
    expect(posix?.name).toBe('example.txt');
    expect(posix?.size).toBe(1234);
    expect(posix?.isDir).toBe(false);
    expect(posix?.modified).toBe(Date.UTC(2019, 10, 5));
    expect(parsePosixLine('drwxrwxr-x 1 root dialout 4096 Nov 5 2018 provola')?.isDir).toBe(true);
    expect(parsePosixLine('lrwxrwxrwx 1 u g 4 Jan 1 2020 link -> target')?.name).toBe('link');

    const dos = parseDosLine('10-19-20  03:19PM <DIR> pub');
    expect(dos).toMatchObject({ name: 'pub', isDir: true, size: 0 });
    expect(parseDosLine('04-08-14  03:09PM 403   readme.txt')).toMatchObject({ name: 'readme.txt', isDir: false, size: 403 });
  });

  it('ftp_timestamp_rejects_an_invalid_mlsd_calendar_date', () => {
    expect(parseMlsxLine('type=file;size=3;modify=20230230010203; bad.txt')).toBeNull();
  });

  it('ftp_timestamp_accepts_a_valid_leap_day', () => {
    expect(parseMlsxLine('type=file;size=3;modify=20240229010203; leap.txt'))
      .toMatchObject({ modified: Date.UTC(2024, 1, 29, 1, 2, 3) });
  });

  it('ftp_timestamp_preserves_the_mlsd_systemtime_pre_epoch_fallback', () => {
    // suppaftp casts timestamp() to u64, then checked_add falls back to epoch.
    expect(parseMlsxLine('type=file;size=3;modify=19000101000000; old.txt'))
      .toMatchObject({ modified: 0 });
  });

  it('ftp_timestamp_uses_whole_seconds_for_the_mlsd_systemtime', () => {
    // chrono timestamp() excludes the leap-second nanosecond component.
    expect(parseMlsxLine('type=file;size=3;modify=20161231235960; leap.txt'))
      .toMatchObject({ modified: Date.UTC(2016, 11, 31, 23, 59, 59) });
  });

  it.each(['20230230010203', '20161231235960'])('ftp_timestamp_rejects_invalid_mdtm_via_real_stat: %s', async timestamp => {
    const { server, host, port } = await spawnFakeFtp({
      files: { '/deep-student-sync/bad-time.txt': 'abc' },
    });
    ftpServers.push(server);
    server.modified.set('/deep-student-sync/bad-time.txt', timestamp);
    const error = await failure(fakeStorage({ host, port }).stat('bad-time.txt'));
    expect(error).toBeInstanceOf(CloudStorageError);
    expect(error).toMatchObject({ value: { error_type: 'FileSystem' } });
    expect(error.message).toContain('FTP MDTM 失败');
    expect(server.commands.some(command => command.startsWith('MDTM '))).toBe(true);
  });

  it('parse_list_entry_prefers_mlsd_then_list', () => {
    // ftp.rs:367 tries MLSD first. suppaftp's MLSD parser accepts any line, so a LIST
    // line is parsed as an MLSD entry whose name is the whole line (inherited bug).
    expect(parseListEntry('type=file;size=3; a.txt')?.name).toBe('a.txt');
    expect(parseListEntry('-rw-r--r-- 1 u g 10 Jan 1 2020 a.txt')?.name).toBe('-rw-r--r-- 1 u g 10 Jan 1 2020 a.txt');
    expect(parsePosixLine('-rw-r--r-- 1 u g 10 Jan 1 2020 a.txt')?.name).toBe('a.txt');
  });

  it('ftps_sends_auth_tls_before_credentials', async () => {
    const { server, host, port } = await spawnFakeFtp();
    ftpServers.push(server);
    const storage = fakeStorage({ host, port }, 'deep-student-sync', true);
    const internals = storage as unknown as { createClient(): Promise<unknown> };

    const error = await failure(internals.createClient());
    expect(error.message).toContain('FTP TLS 升级失败');
    expect(server.commands[0]).toBe('AUTH TLS');
    expect(server.commands.some(command => command.startsWith('USER '))).toBe(false);
    expect(server.commands.some(command => command.startsWith('PASS '))).toBe(false);
  });

  it('upload_writes_a_tmp_object_then_renames_it', async () => {
    const { server, host, port } = await spawnFakeFtp({ dirs: ['/deep-student-sync'] });
    ftpServers.push(server);
    const storage = fakeStorage({ host, port });

    await storage.put('dir/a.txt', Buffer.from('hello'));

    const storIndex = server.commands.findIndex(command => command.startsWith('STOR '));
    expect(storIndex).toBeGreaterThanOrEqual(0);
    const stor = server.commands[storIndex]!;
    const tempName = stor.slice('STOR '.length);
    expect(tempName).toMatch(/^a\.txt\.tmp-[0-9a-f]{32}$/);
    expect(server.commands[storIndex + 1]).toBe(`RNFR ${tempName}`);
    expect(server.commands[storIndex + 2]).toBe('RNTO a.txt');
    expect(server.files.get('/deep-student-sync/dir/a.txt')?.toString()).toBe('hello');
    expect([...server.files.keys()].some(path => path.includes('.tmp-'))).toBe(false);
  });

  it('ftp_contract_source_guards', async () => {
    const { server, host, port } = await spawnFakeFtp({
      files: { '/deep-student-sync/a.txt': 'abc' },
    });
    ftpServers.push(server);
    const storage = fakeStorage({ host, port });

    // Atomic publication: STOR a nonce-suffixed temp object, then RNFR/RNTO.
    await storage.put('dir/a.txt', Buffer.from('hello'));
    const storIndex = server.commands.findIndex(command => command.startsWith('STOR '));
    expect(storIndex).toBeGreaterThanOrEqual(0);
    expect(server.commands[storIndex + 1]).toMatch(/^RNFR a\.txt\.tmp-[0-9a-f]{32}$/);
    expect(server.commands[storIndex + 2]).toBe('RNTO a.txt');

    // MLSD is preferred and directories are traversed.
    const files = await storage.list('');
    expect(server.commands.some(command => command.startsWith('MLSD '))).toBe(true);
    expect(files.map(file => file.key)).toContain('a.txt');

    // Not-found classification is gated on an FTP status code, not a broad substring.
    expect(isNotFoundError(new CloudStorageError('FileSystem', 'FTP DELETE 失败：object not found'))).toBe(false);
    expect(isNotFoundError(new CloudStorageError('FileSystem', 'FTP SIZE 失败：Invalid response: [550] 550 No such file.'))).toBe(true);

    // Data-channel operations carry a positive timeout bound.
    expect(transferTimeoutMs(0)).toBeGreaterThan(0);

    // ftp.rs `self.get_bounded(key, MEMORY_GET_DEFAULT_BUDGET_BYTES)`: legacy get() is budgeted.
    const huge = await spawnFakeFtp({
      files: { '/deep-student-sync/huge.bin': 'x' },
      intercept: command => (command === 'SIZE huge.bin'
        ? { code: 213, text: String(MEMORY_GET_DEFAULT_BUDGET_BYTES + 1) } : null),
    });
    ftpServers.push(huge.server);
    const budgetError = await failure(fakeStorage({ host: huge.host, port: huge.port }).get('huge.bin'));
    expect(budgetError.message).toContain('超出调用方内存预算');
    expect(huge.server.commands.some(command => command.startsWith('RETR '))).toBe(false);

    // Source guards with no observable counterpart in a fake server (ftp.rs rustls/suppaftp
    // backend choice, FTP_DATA_TIMEOUT, read_with_timeout): TLS comes from Node's built-in
    // `node:tls`, every data-channel step and each RETR read is bounded by FTP_DATA_TIMEOUT_MS.
    const source = await readFile(new URL('../src/ftp.ts', import.meta.url), 'utf8');
    const imports = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map(match => match[1]!);
    expect(imports.filter(specifier => !specifier.startsWith('.'))).toEqual(
      ['node:events', 'node:fs/promises', 'node:os', 'node:net', 'node:tls']);
    expect(imports).toContain('../../../platform/util/path.ts');
    expect(source).toContain('stream: idleGuarded(socketChunks(socket))');
    expect(source.match(/FTP_DATA_TIMEOUT_MS,\n/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it('failed_rename_removes_the_tmp_object_and_never_publishes_the_final_name', async () => {
    const { server, host, port } = await spawnFakeFtp({ rntoStatus: 550 });
    ftpServers.push(server);
    const storage = fakeStorage({ host, port });

    const error = await failure(storage.put('dir/a.txt', Buffer.from('hello')));
    expect(error.message).toContain('FTP RENAME 失败');
    expect(server.commands.some(command => command.startsWith('DELE a.txt.tmp-'))).toBe(true);
    expect(server.files.has('/deep-student-sync/dir/a.txt')).toBe(false);
    expect([...server.files.keys()].some(path => path.includes('.tmp-'))).toBe(false);
  });

  it('listing_prefers_mlsd_and_recurses_into_subdirectories', async () => {
    const { server, host, port } = await spawnFakeFtp({
      files: {
        '/deep-student-sync/a.txt': 'abc',
        '/deep-student-sync/b/c.txt': 'hello',
      },
    });
    server.modified.set('/deep-student-sync/b/c.txt', '20260102120000');
    ftpServers.push(server);
    const storage = fakeStorage({ host, port });

    const files = await storage.list('');
    expect(files.map(file => file.key)).toEqual(['b/c.txt', 'a.txt']);
    expect(files[0]!.size).toBe(5);
    expect(files[0]!.lastModified).toBe('2026-01-02T12:00:00Z');
    const listings = server.commands.filter(command => command.startsWith('MLSD ') || command.startsWith('LIST '));
    expect(listings).toEqual(['MLSD /deep-student-sync', 'MLSD /deep-student-sync/b']);
  });

  it('listing_falls_back_to_list_when_mlsd_is_rejected', async () => {
    const { server, host, port } = await spawnFakeFtp({
      files: { '/deep-student-sync/a.txt': 'abc' },
      mlsdStatus: 500,
    });
    ftpServers.push(server);
    const storage = fakeStorage({ host, port });

    const files = await storage.list('');
    expect(server.commands.some(command => command.startsWith('LIST '))).toBe(true);
    // Inherited suppaftp behaviour: the MLSD parser accepts any line, so a LIST
    // line becomes one entry whose name is the whole line (reported, not fixed).
    expect(files).toHaveLength(1);
    expect(files[0]!.key).toBe('-rw-r--r-- 1 user group 3 Jan 1 2026 a.txt');
    expect(files[0]!.size).toBe(0);
    expect(files[0]!.lastModified).toBe('1970-01-01T00:00:00Z');
  });

  it('listing_reports_truncation_after_the_directory_budget', async () => {
    const dirs: string[] = [];
    for (let index = 0; index <= FTP_LIST_MAX_DIRS; index += 1) {
      dirs.push(`/deep-student-sync/d${index}`);
    }
    const { server, host, port } = await spawnFakeFtp({ dirs });
    ftpServers.push(server);
    const storage = fakeStorage({ host, port });

    const outcome = await storage.listOutcome('');
    expect(outcome.truncated).toBe(true);
    expect(outcome.files).toEqual([]);
    expect(server.commands.filter(command => command.startsWith('MLSD ')))
      .toHaveLength(FTP_LIST_MAX_DIRS);
  });

  it('ambiguous_550_is_an_error_and_explicit_missing_is_null', async () => {
    const { server, host, port } = await spawnFakeFtp({
      files: { '/deep-student-sync/a.txt': 'abc' },
      intercept: command => (command === 'SIZE a.txt' ? { code: 550, text: 'Permission denied.' } : null),
    });
    ftpServers.push(server);
    const storage = fakeStorage({ host, port });

    const error = await failure(storage.get('a.txt'));
    expect(error.message).toContain('FTP SIZE 失败');
    expect(error.message).toContain('Permission denied');

    const missing = await spawnFakeFtp({ files: { '/deep-student-sync/a.txt': 'abc' } });
    ftpServers.push(missing.server);
    expect(await fakeStorage(missing).get('missing.txt')).toBeNull();
  });

  it('budget_is_rejected_before_the_data_channel_is_opened', async () => {
    const { server, host, port } = await spawnFakeFtp({
      files: { '/deep-student-sync/a.bin': '0123456789' },
    });
    ftpServers.push(server);
    const storage = fakeStorage({ host, port });

    const error = await failure(storage.getBounded('a.bin', 4));
    expect(error.message).toContain('超出调用方内存预算');
    expect(server.commands.some(command => command.startsWith('RETR '))).toBe(false);
    expect(server.commands.some(command => command === 'EPSV')).toBe(false);
  });

  it('put_file_verifies_the_remote_size_and_deletes_a_short_write', async () => {
    const dir = await tempDir();
    const local = join(dir, 'a.txt');
    await writeFile(local, 'hello');

    const short = await spawnFakeFtp({ dirs: ['/deep-student-sync'], storeLimit: 3 });
    ftpServers.push(short.server);
    const error = await failure(fakeStorage(short).putFile('a.txt', local));
    expect(error.message).toContain('云端对象上传后大小不一致');
    expect(short.server.commands.some(command => command.startsWith('DELE a.txt'))).toBe(true);

    const exact = await spawnFakeFtp({ dirs: ['/deep-student-sync'] });
    ftpServers.push(exact.server);
    const checksum = await fakeStorage(exact).putFile('a.txt', local);
    expect(checksum).toBe(createHash('sha256').update('hello').digest('hex'));
    expect(exact.server.files.get('/deep-student-sync/a.txt')?.toString()).toBe('hello');
  });

  it('read_paths_never_create_directories', async () => {
    const { server, host, port } = await spawnFakeFtp({
      files: { '/deep-student-sync/a.txt': 'hello' },
    });
    ftpServers.push(server);
    const storage = fakeStorage({ host, port });

    expect(Buffer.from((await storage.get('a.txt'))!).toString()).toBe('hello');
    const info = await storage.stat('a.txt');
    expect(info).toMatchObject({ key: 'a.txt', size: 5, lastModified: '2026-01-01T12:00:00Z' });
    await storage.list('');
    expect(server.commands.filter(command => command.startsWith('MKD '))).toEqual([]);
  });

  it('get_file_downloads_through_the_data_channel_and_checks_the_size', async () => {
    const dir = await tempDir();
    const dest = join(dir, 'a.txt');
    const { server, host, port } = await spawnFakeFtp({
      files: { '/deep-student-sync/a.txt': 'hello' },
    });
    ftpServers.push(server);
    const storage = fakeStorage({ host, port });

    const checksum = await storage.getFile('a.txt', dest);
    expect(checksum).toBe(createHash('sha256').update('hello').digest('hex'));
    expect(await readFile(dest, 'utf8')).toBe('hello');
    expect(server.commands.some(command => command === 'RETR a.txt')).toBe(true);
  });

  it('stream_to_file_accepts_exact_size_and_returns_sha256', async () => {
    const data = Uint8Array.from({ length: 10_000 }, (_, index) => index % 251);
    const dir = await tempDir();
    const dest = join(dir, 'exact.bin');

    const checksum = await streamToFile(chunksOf(data), dest, data.byteLength, null);

    expect(checksum).toBe(createHash('sha256').update(data).digest('hex'));
    expect(new Uint8Array(await readFile(dest))).toEqual(data);
  });

  it('stream_to_file_rejects_truncated_stream', async () => {
    const data = Uint8Array.from({ length: 4_096 }, (_, index) => index % 251);
    const dir = await tempDir();
    const dest = join(dir, 'truncated.bin');

    const error = await streamToFile(chunksOf(data), dest, 10_000, null).catch(caught => caught);
    expect(error).toBeInstanceOf(CloudStorageError);
    expect(error.message).toContain('下载不完整');
  });

  it('stream_to_file_rejects_oversized_stream', async () => {
    const data = new Uint8Array(8_192).fill(0x5a);
    const dir = await tempDir();
    const dest = join(dir, 'oversized.bin');

    const error = await streamToFile(chunksOf(data), dest, 1_024, null).catch(caught => caught);
    expect(error).toBeInstanceOf(CloudStorageError);
    expect(error.message).toContain('下载不完整');
  });

  it('stream_to_file_aborts_oversized_stream_midway', async () => {
    const data = new Uint8Array(8 * 1024 * 1024).fill(0x42);
    const dir = await tempDir();
    const dest = join(dir, 'flood.bin');

    const error = await streamToFile(chunksOf(data, 64 * 1024), dest, 1_024, null).catch(caught => caught);
    expect(error.message).toContain('下载不完整');

    const written = (await stat(dest)).size;
    expect(written).toBeLessThanOrEqual(1_024 + 64 * 1024);
  });

  it('with_retry_does_not_retry_budget_exceeded_errors', async () => {
    const budgetError = (): CloudStorageError =>
      ensureDeclaredLenWithinBudget('FTP', 'changes/huge.bin', Number.MAX_SAFE_INTEGER, 4_096) as never;
    const captured = (() => {
      try { budgetError(); } catch (error) { return error as CloudStorageError; }
      throw new Error('declared length over budget must throw');
    })();
    expect(captured.message).toContain('超出调用方内存预算');
    expect(ensureDeclaredLenWithinBudget).toBeTypeOf('function');

    let attempts = 0;
    const error = await withRetry(async () => {
      attempts += 1;
      throw captured;
    }).catch(caught => caught);
    expect(error.message).toContain('超出调用方内存预算');
    expect(attempts).toBe(1);

    let retried = 0;
    const plain = await withRetry(async () => {
      retried += 1;
      throw new CloudStorageError('Network', 'FTP 下载不完整：服务端声明 10 字节，实际收到 4 字节');
    }).catch(caught => caught);
    expect(plain.message).toContain('下载不完整');
    expect(retried).toBe(3);
  });

  it('transfer_timeout_scales_with_size', () => {
    expect(transferTimeoutMs(0)).toBe(120_000);
    expect(transferTimeoutMs(64 * 1024 * 120)).toBe(240_000);
  });
});

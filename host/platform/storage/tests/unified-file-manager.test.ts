import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { copyFileVerified, isVirtualUri, queuePersistableSafUri, rejectDoubleEncodedVirtualUri } from '../node.ts';
import {
  DOUBLE_ENCODED_VIRTUAL_URI_REJECTED,
  PENDING_SAF_PERSIST_DIR,
  PENDING_SAF_PERSIST_FILE,
  canonicalizeLenient,
  denyHiddenLocalPath,
  digestCopy,
  digestRead,
  ensureEnoughTempSpace,
  ensureIdenticalCopy,
  lexicalNormalizePath,
  persistableSafQueueFile,
  requiredTempCopyBytes,
} from '../unified-file-manager.ts';

const dirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-ufm-'));
  dirs.push(dir);
  return dir;
}
function readerOf(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  return (async function* () { yield bytes; })();
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

it('lexical_normalize_path_resolves_dot_segments', () => {
  expect(lexicalNormalizePath('/a/b/../c/./d')).toBe('/a/c/d');
  expect(lexicalNormalizePath('/app/data/../../home/user/.ssh/key')).toBe('/home/user/.ssh/key');
  expect(lexicalNormalizePath('/../a')).toBe('/a');
  expect(lexicalNormalizePath('../../a/b/../c')).toBe('../../a/c');
});

it('canonicalize_lenient_handles_missing_files', () => {
  const temp = os.tmpdir();
  const canonicalTemp = fs.realpathSync(temp);

  const missing = path.join(temp, 'deep_student_test_missing_file.bin');
  expect(canonicalizeLenient(missing)).toBe(path.join(canonicalTemp, 'deep_student_test_missing_file.bin'));

  const traversal = path.join(temp, 'nonexistent_dir/../deep_student_test_missing_file.bin');
  expect(canonicalizeLenient(traversal)).toBe(path.join(canonicalTemp, 'deep_student_test_missing_file.bin'));
});

it('copy_file_verified_copies_local_files_and_rejects_virtual_targets', async () => {
  const dir = tmp();
  const source = path.join(dir, 'staged.zip');
  const target = path.join(dir, 'nested', 'export.zip');
  fs.writeFileSync(source, 'verified-copy-payload');

  expect(await copyFileVerified(source, target)).toBe('verified-copy-payload'.length);
  expect(fs.readFileSync(target, 'utf8')).toBe('verified-copy-payload');

  await expect(copyFileVerified(source, 'content://downloads/export.zip')).rejects.toEqual({
    error_type: 'FileSystem',
    message: '写入文件失败: content://downloads/export.zip (虚拟路径在当前平台不可用)',
    details: null,
  });
  expect(isVirtualUri('content://downloads/export.zip')).toBe(true);
  expect(fs.readFileSync(source, 'utf8')).toBe('verified-copy-payload');
  await expect(copyFileVerified('content://downloads/export.zip', target)).rejects.toEqual({
    error_type: 'FileSystem',
    message: '读取文件失败: content://downloads/export.zip (虚拟路径在当前平台不可用)',
    details: null,
  });
});

it('copy_file_verified_preserves_step_specific_error_context', async () => {
  const dir = tmp();
  const missing = path.join(dir, 'missing.bin');
  await expect(copyFileVerified(missing, path.join(dir, 'target.bin')))
    .rejects.toMatchObject({ error_type: 'FileSystem', message: expect.stringMatching(new RegExp(`^读取文件失败: ${missing} \\(`)) });

  const source = path.join(dir, 'source.bin');
  fs.writeFileSync(source, 'payload');
  const targetDirectory = path.join(dir, 'target-dir');
  fs.mkdirSync(targetDirectory);
  await expect(copyFileVerified(source, targetDirectory))
    .rejects.toMatchObject({ error_type: 'FileSystem', message: expect.stringMatching(new RegExp(`^写入文件失败: ${targetDirectory} \\(`)) });
});

it('digest_copy_roundtrip_matches_reread', async () => {
  const payload = Buffer.from('saf-export-verify-payload');
  const chunks: Uint8Array[] = [];
  const copy = await digestCopy(readerOf(payload), (chunk) => chunks.push(chunk), 'roundtrip');
  expect(copy.bytes).toBe(payload.length);
  const read = await digestRead(readerOf(Buffer.concat(chunks)), 'roundtrip');
  ensureIdenticalCopy(copy.bytes, copy.digest, read.bytes, read.digest, 'roundtrip');
});

it('ensure_identical_copy_rejects_size_or_hash_mismatch', async () => {
  const copy = await digestCopy(readerOf(Buffer.from('abc')), () => {}, 'mismatch');
  expect(() => ensureIdenticalCopy(copy.bytes, copy.digest, copy.bytes + 1, copy.digest, 'short'))
    .toThrow(/目标回读校验失败/);
  const other = new Uint8Array(32);
  expect(() => ensureIdenticalCopy(copy.bytes, copy.digest, copy.bytes, other, 'tampered'))
    .toThrow(/目标回读校验失败/);
});

it('ensure_enough_temp_space_requires_double_source_size', () => {
  expect(requiredTempCopyBytes(80)).toBe(160);
  expect(requiredTempCopyBytes(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
  expect(() => ensureEnoughTempSpace(160, 80, 'enough')).not.toThrow();
  expect(() => ensureEnoughTempSpace(159, 80, 'short')).toThrow(/临时物化空间不足，已停止以免半包/);
});

it('reject_double_encoded_virtual_uri_keeps_raw_content_ok', () => {
  expect(() => rejectDoubleEncodedVirtualUri('content://com.android.externalstorage.documents/document/primary%3Abackup.zip')).not.toThrow();
  expect(() => rejectDoubleEncodedVirtualUri('/tmp/backup.zip')).not.toThrow();
  expect(() => rejectDoubleEncodedVirtualUri('content%3A%2F%2Fcom.android.externalstorage.documents%2Fdocument%2Fprimary%3Abackup.zip'))
    .toThrow(DOUBLE_ENCODED_VIRTUAL_URI_REJECTED);
});

it('queue_persistable_saf_uri_writes_content_only', () => {
  const dir = tmp();
  const content = 'content://com.android.externalstorage.documents/document/primary%3Abackup.zip';
  queuePersistableSafUri(dir, `  ${content}  `);
  const pending = persistableSafQueueFile(dir, content);
  expect(fs.readFileSync(pending, 'utf8')).toBe(content);
  expect(pending.startsWith(path.join(dir, PENDING_SAF_PERSIST_DIR))).toBe(true);
  expect(fs.existsSync(path.join(dir, PENDING_SAF_PERSIST_FILE))).toBe(false);

  const other = 'content://com.android.providers.downloads.documents/document/446';
  queuePersistableSafUri(dir, other);
  expect(fs.readFileSync(persistableSafQueueFile(dir, other), 'utf8')).toBe(other);
  expect(fs.readFileSync(pending, 'utf8')).toBe(content);

  queuePersistableSafUri(dir, '/tmp/backup.zip');
  queuePersistableSafUri(dir, 'primary:Download/backup.zip');
  expect(fs.readFileSync(pending, 'utf8')).toBe(content);

  expect(() => queuePersistableSafUri(dir, 'content%3A%2F%2Fcom.android.externalstorage.documents%2Fdocument%2Fprimary%3Abackup.zip'))
    .toThrow(DOUBLE_ENCODED_VIRTUAL_URI_REJECTED);
  expect(fs.readFileSync(pending, 'utf8')).toBe(content);

  expect(() => queuePersistableSafUri(dir, 'content://authority/document/1\nextra'))
    .toThrow(/SAF persist 队列拒绝过长或含换行的 URI/);
});

it('queue_persistable_saf_uri_handles_concurrent_producers', async () => {
  const dir = tmp();
  const same = 'content://com.android.providers.downloads.documents/document/445';
  const other = 'content://com.android.providers.downloads.documents/document/446';
  const third = 'content://com.android.providers.downloads.documents/document/447';
  const uris = [same, same, same, same, other, third];

  await Promise.all(uris.map((uri) => Promise.resolve().then(() => queuePersistableSafUri(dir, uri))));

  for (const uri of [same, other, third]) {
    expect(fs.readFileSync(persistableSafQueueFile(dir, uri), 'utf8')).toBe(uri);
  }
  const entries = fs.readdirSync(path.join(dir, PENDING_SAF_PERSIST_DIR));
  expect(entries).toHaveLength(3);
  expect(entries.every((entry) => path.extname(entry) === '.uri')).toBe(true);
});

it('unified_file_manager.rs:441 deny_hidden_local_path: app dirs exempt by component prefix, hidden paths elsewhere rejected', () => {
  const dir = tmp();
  const app = path.join(dir, 'app');
  for (const sub of ['.secure', '..cache', 'notes']) fs.mkdirSync(path.join(app, sub), { recursive: true });
  fs.mkdirSync(path.join(dir, '.ssh'));
  for (const file of ['.secure/k', '..cache/f', 'notes/a.md']) fs.writeFileSync(path.join(app, file), 'x');
  fs.writeFileSync(path.join(dir, '.ssh', 'key'), 'x');

  expect(() => denyHiddenLocalPath([app], path.join(app, '.secure', 'k'))).not.toThrow();
  // `..cache` is a child of the app dir (Rust Path::starts_with), not a `..` climb out of it.
  expect(() => denyHiddenLocalPath([app], path.join(app, '..cache', 'f'))).not.toThrow();
  expect(() => denyHiddenLocalPath([path.join(dir, 'app-other')], path.join(app, 'notes', 'a.md'))).not.toThrow();
  expect(() => denyHiddenLocalPath([app], path.join(dir, '.ssh', 'key'))).toThrow(/隐藏路径/);
  expect(() => denyHiddenLocalPath([app], `${app}${path.sep}..${path.sep}.ssh${path.sep}key`)).toThrow(/隐藏路径/);
});

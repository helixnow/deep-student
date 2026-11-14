import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../host/kernel/testing.ts';
import shellPlugin from '../index.ts';
import { decodeRawBytes } from '../raw-bytes.ts';

const hosts: TestHost[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.dispose()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function setup(): Promise<{ host: TestHost; appDir: string; outside: string }> {
  const appDir = mkdtempSync(join(tmpdir(), 'dstu-f2-app-'));
  const outside = mkdtempSync(join(tmpdir(), 'dstu-f2-out-'));
  dirs.push(appDir, outside);
  const host = await createTestHost({
    plugins: [shellPlugin],
    shell: (op) => {
      if (op === 'app.dataDirs') return { data: appDir, localData: appDir, cache: appDir };
      throw new Error(`unexpected shell op: ${op}`);
    },
  });
  hosts.push(host);
  return { host, appDir, outside };
}

it('read_file_text reads UTF-8, maps file:// and rejects non-UTF-8', async () => {
  const { host, outside } = await setup();
  const file = join(outside, 'notes.txt');
  writeFileSync(file, 'hello 世界');
  expect(await host.invoke('read_file_text', { path: file })).toBe('hello 世界');
  expect(await host.invoke('read_file_text', { path: `file://${file}` })).toBe('hello 世界');

  const invalid = join(outside, 'invalid.txt');
  writeFileSync(invalid, Buffer.from([0xff, 0xfe]));
  await expect(host.invoke('read_file_text', { path: invalid })).rejects.toMatchObject({
    error_type: 'FileSystem',
    message: '文件编码不是有效的 UTF-8',
  });
});

it('denies hidden path segments outside app data but allows app data and rejects encoded traversal', async () => {
  const { host, appDir, outside } = await setup();
  const hiddenOutside = join(outside, '.hidden');
  mkdirSync(hiddenOutside);
  const secret = join(hiddenOutside, 'secret.txt');
  writeFileSync(secret, 'x');
  await expect(host.invoke('read_file_text', { path: secret })).rejects.toMatchObject({
    error_type: 'Validation',
    message: `拒绝读取隐藏路径: ${secret}`,
  });
  await expect(host.invoke('read_file_text', { path: join(outside, '%2Ehidden', 'secret.txt') })).rejects.toMatchObject({
    error_type: 'Validation',
  });

  const appHidden = join(appDir, '.cache-file');
  writeFileSync(appHidden, 'allowed');
  expect(await host.invoke('read_file_text', { path: appHidden })).toBe('allowed');

  const traversal = join(outside, 'visible', '..', '.hidden', 'secret.txt');
  await expect(host.invoke('read_file_text', { path: traversal })).rejects.toMatchObject({
    error_type: 'Validation',
    message: `拒绝读取隐藏路径: ${traversal}`,
  });
});

it('read_file_bytes enforces the 200MB cap and returns a raw-bytes envelope', async () => {
  const { host, outside } = await setup();
  const file = join(outside, 'data.bin');
  writeFileSync(file, Buffer.from([1, 2, 3, 4]));
  const envelope = await host.invoke<Record<string, string>>('read_file_bytes', { path: file });
  expect(Array.from(decodeRawBytes(envelope) ?? [])).toEqual([1, 2, 3, 4]);
  await expect(host.invoke('read_file_bytes', { path: file, maxBytes: 3 })).rejects.toMatchObject({
    error_type: 'Validation',
    message: `文件过大: 4 字节，超过读取上限 3 字节: ${file}`,
  });

  const huge = join(outside, 'huge.bin');
  writeFileSync(huge, '');
  truncateSync(huge, 200 * 1024 * 1024 + 1);
  await expect(host.invoke('read_file_bytes', { path: huge })).rejects.toMatchObject({
    error_type: 'Validation',
    message: `文件过大: ${200 * 1024 * 1024 + 1} 字节，超过读取上限 ${200 * 1024 * 1024} 字节: ${huge}`,
  });
});

it('get_file_size and hash_file match the file contents', async () => {
  const { host, outside } = await setup();
  const file = join(outside, 'hash.txt');
  const content = Buffer.from('sha-256 payload');
  writeFileSync(file, content);
  expect(await host.invoke('get_file_size', { path: file })).toBe(content.length);
  expect(await host.invoke('hash_file', { path: file })).toBe(createHash('sha256').update(content).digest('hex'));
  await expect(host.invoke('get_file_size', { path: join(outside, 'missing.txt') })).rejects.toMatchObject({
    error_type: 'FileSystem',
    message: `获取文件信息失败: ${join(outside, 'missing.txt')} (No such file or directory (os error 2))`,
  });
});

it('save_text_to_file creates parents, truncates and keeps UTF-8 bytes', async () => {
  const { host, outside } = await setup();
  const file = join(outside, 'nested', 'dir', 'out.txt');
  await host.invoke('save_text_to_file', { path: file, content: 'first 内容' });
  expect(await host.invoke('read_file_text', { path: file })).toBe('first 内容');
  await host.invoke('save_text_to_file', { path: file, content: 'second' });
  expect(await host.invoke('read_file_text', { path: file })).toBe('second');
});

it('copy_file verifies the readback and reports a missing source like Rust', async () => {
  const { host, outside } = await setup();
  const source = join(outside, 'source.bin');
  const target = join(outside, 'deep', 'target.bin');
  const payload = Buffer.alloc(200_000);
  for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
  writeFileSync(source, payload);
  await host.invoke('copy_file', { sourcePath: source, destPath: target });
  expect(await host.invoke('hash_file', { path: target })).toBe(createHash('sha256').update(payload).digest('hex'));

  const missing = join(outside, 'missing.bin');
  await expect(host.invoke('copy_file', { sourcePath: missing, destPath: target })).rejects.toMatchObject({
    error_type: 'FileSystem',
    message: `读取文件失败: ${missing} (No such file or directory (os error 2))`,
  });
});

it('mobile virtual URIs fail with the desktop Tauri fs error and double-encoded URIs are rejected', async () => {
  const { host } = await setup();
  await expect(host.invoke('read_file_text', { path: 'content://media/external/1' })).rejects.toMatchObject({
    error_type: 'FileSystem',
    message: '读取文件失败: content://media/external/1 (URL is not a valid path)',
  });
  await expect(host.invoke('read_file_text', { path: 'content%3A%2F%2Fmedia%2F1' })).rejects.toMatchObject({
    error_type: 'Validation',
    message: '路径像是双重编码的安全 URI，已拒绝以免破坏授权。请传入原始 content:// 地址',
  });
});

it('dot components and NUL padding are normalized before the hidden-path check', async () => {
  const { host, outside } = await setup();
  const file = join(outside, 'plain.txt');
  writeFileSync(file, 'ok');
  expect(await host.invoke('read_file_text', { path: `\0${join(outside, '.', 'plain.txt')}\0` })).toBe('ok');
  const relative = join(homedir(), '.ssh', 'id_rsa');
  await expect(host.invoke('read_file_text', { path: relative })).rejects.toMatchObject({ error_type: 'Validation' });
});

/**
 * paths 中供移动端复用的叶子模块：运行时不得触达 Node 专有依赖。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { checkModulesClosure } from '../../../../scripts/portability/lib/portability.mjs';
import { errnoCode, ioMessage } from '../compat.ts';
import { ioMessageFor } from '../io-error.ts';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

it('io-error never loads Node modules at runtime', () => {
  expect(checkModulesClosure(ROOT, ['host/platform/paths/io-error.ts'])).toEqual([]);
});

it('compat.ts is a portable entry: the file primitives live in util/durable-fs.ts', () => {
  expect(checkModulesClosure(ROOT, ['host/platform/paths/compat.ts'])).toEqual([]);
  expect(checkModulesClosure(ROOT, ['host/platform/util/durable-fs.ts']).map((v) => v.key))
    .toEqual(['node-builtin:fs', 'node-global:process']);
});

it('ioMessageFor formats Unix errno like Rust io::Error and falls back to the message elsewhere', () => {
  const error = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT', errno: -2 });
  expect(ioMessageFor(error, 'linux')).toBe('No such file or directory (os error 2)');
  expect(ioMessageFor(error, 'darwin')).toBe('No such file or directory (os error 2)');
  expect(ioMessageFor(error, 'win32')).toBe('ENOENT: no such file');
  expect(ioMessageFor('plain', 'linux')).toBe('plain');
  expect(ioMessage(error)).toBe(ioMessageFor(error, process.platform));
  expect(errnoCode(error)).toBe('ENOENT');
});

it('ioMessageFor uses the strerror text of the platform libc: macOS differs from glibc for several codes', () => {
  const nodeError = (code: string, errno: number) => Object.assign(new Error(`${code}: node text`), { code, errno });
  // macOS libc 文案（本机 `perl -e '$!=N; print "$!"'` 核对）与 glibc 不同的码。
  const differing: Array<[string, number, number, string, string]> = [
    ['EBUSY', 16, 16, 'Resource busy', 'Device or resource busy'],
    ['EXDEV', 18, 18, 'Cross-device link', 'Invalid cross-device link'],
    ['ETIMEDOUT', 60, 110, 'Operation timed out', 'Connection timed out'],
    ['EILSEQ', 92, 84, 'Illegal byte sequence', 'Invalid or incomplete multibyte or wide character'],
  ];
  for (const [code, darwinErrno, linuxErrno, darwinText, glibcText] of differing) {
    expect(ioMessageFor(nodeError(code, -darwinErrno), 'darwin')).toBe(`${darwinText} (os error ${darwinErrno})`);
    expect(ioMessageFor(nodeError(code, -linuxErrno), 'linux')).toBe(`${glibcText} (os error ${linuxErrno})`);
  }
  // 外置盘、句柄耗尽等场景常见、两边文案相同的码。
  const shared: Array<[string, number, string]> = [
    ['EAGAIN', 35, 'Resource temporarily unavailable'], ['EMFILE', 24, 'Too many open files'],
    ['ENFILE', 23, 'Too many open files in system'], ['ETXTBSY', 26, 'Text file busy'],
    ['EFBIG', 27, 'File too large'], ['ENOTSUP', 45, 'Operation not supported'],
  ];
  for (const [code, errno, text] of shared) {
    expect(ioMessageFor(nodeError(code, -errno), 'darwin')).toBe(`${text} (os error ${errno})`);
    expect(ioMessageFor(nodeError(code, -errno), 'linux')).toBe(`${text} (os error ${errno})`);
  }
});

it.skipIf(process.platform === 'win32')('ioMessage maps a real Node fs error to the Rust io::Error Display', () => {
  const dir = mkdtempSync(join(tmpdir(), 'w07-io-error-'));
  try {
    const file = join(dir, 'not-a-dir');
    writeFileSync(file, 'x');
    let caught: unknown;
    try { mkdirSync(file, { recursive: true }); } catch (error) { caught = error; }
    // Rust `fs::create_dir_all` 对普通文件：`File exists (os error 17)`；Node 原文带路径与 syscall。
    expect(ioMessage(caught)).toBe('File exists (os error 17)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { containedBlobPath } from '../api.ts';

const roots: string[] = [];

function sandbox(): { blobsDir: string; outside: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-blob-path-'));
  roots.push(base);
  const blobsDir = path.join(base, 'vfs_blobs');
  fs.mkdirSync(path.join(blobsDir, 'ab'), { recursive: true });
  fs.writeFileSync(path.join(blobsDir, 'ab', 'abcdef.png'), 'inside');
  const outside = path.join(base, 'outside.txt');
  fs.writeFileSync(outside, 'secret');
  return { blobsDir, outside };
}

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('containedBlobPath', () => {
  it('RF-W04-blob-relative-path-escape: keeps relative paths that stay inside vfs_blobs', () => {
    const { blobsDir } = sandbox();
    expect(containedBlobPath(blobsDir, 'ab/abcdef.png', fs.realpathSync)).toBe(path.join(blobsDir, 'ab', 'abcdef.png'));
    expect(containedBlobPath(blobsDir, 'ab/./abcdef.png')).toBe(path.join(blobsDir, 'ab', 'abcdef.png'));
    // A blob that is not on disk (yet) is not an escape; callers report it as missing.
    expect(containedBlobPath(blobsDir, 'cd/missing.png', fs.realpathSync)).toBe(path.join(blobsDir, 'cd', 'missing.png'));
  });

  it('RF-W04-blob-relative-path-escape: rejects parent segments, absolute paths and empty values', () => {
    const { blobsDir, outside } = sandbox();
    for (const relativePath of [
      '../outside.txt',
      'ab/../../outside.txt',
      'ab\\..\\..\\outside.txt',
      '..',
      outside,
      '/etc/passwd',
      '\\Windows\\win.ini',
      'C:\\Windows\\win.ini',
      'C:/Windows/win.ini',
      'C:outside.txt',
      '\\\\server\\share\\file',
      '',
      '.',
      'ab/\u0000.png',
    ]) {
      expect(containedBlobPath(blobsDir, relativePath, fs.realpathSync), relativePath).toBeNull();
      expect(containedBlobPath(blobsDir, relativePath), relativePath).toBeNull();
    }
  });

  it.skipIf(process.platform === 'win32')('RF-W04-blob-relative-path-escape: rejects a symlink inside vfs_blobs that resolves outside it', () => {
    const { blobsDir, outside } = sandbox();
    fs.symlinkSync(outside, path.join(blobsDir, 'ab', 'link.png'));
    fs.symlinkSync(path.dirname(outside), path.join(blobsDir, 'up'));
    expect(containedBlobPath(blobsDir, 'ab/link.png', fs.realpathSync)).toBeNull();
    expect(containedBlobPath(blobsDir, 'up/outside.txt', fs.realpathSync)).toBeNull();
    // Without a realpath only the lexical checks apply.
    expect(containedBlobPath(blobsDir, 'ab/link.png')).toBe(path.join(blobsDir, 'ab', 'link.png'));
  });

  it.skipIf(process.platform === 'win32')('RF-W04-blob-relative-path-escape: follows symlinks that stay inside, including a symlinked vfs_blobs', () => {
    const { blobsDir } = sandbox();
    fs.symlinkSync(path.join(blobsDir, 'ab', 'abcdef.png'), path.join(blobsDir, 'ab', 'alias.png'));
    expect(containedBlobPath(blobsDir, 'ab/alias.png', fs.realpathSync)).toBe(path.join(blobsDir, 'ab', 'alias.png'));
    const linkedRoot = path.join(path.dirname(blobsDir), 'linked_blobs');
    fs.symlinkSync(blobsDir, linkedRoot);
    expect(containedBlobPath(linkedRoot, 'ab/abcdef.png', fs.realpathSync)).toBe(path.join(linkedRoot, 'ab', 'abcdef.png'));
  });

  it('RF-W04-blob-relative-path-escape: a realpath failure other than ENOENT rejects the path', () => {
    const { blobsDir } = sandbox();
    const loop = (): string => { throw Object.assign(new Error('ELOOP'), { code: 'ELOOP' }); };
    expect(containedBlobPath(blobsDir, 'ab/abcdef.png', loop)).toBeNull();
  });
});

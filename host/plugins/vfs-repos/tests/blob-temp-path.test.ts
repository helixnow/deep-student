import path from 'node:path';
import { expect, it } from 'vitest';
import { blobTempPath } from '../repository/blobs.ts';

it('blob temp file is Path::with_extension of the final component, on POSIX and Windows paths', () => {
  expect(blobTempPath('/data/vfs_blobs/ab/abcd.png', 'ID', path.posix)).toBe('/data/vfs_blobs/ab/abcd.ID.tmp');
  expect(blobTempPath('/data/a.b/vfs_blobs/ab/abcd', 'ID', path.posix)).toBe('/data/a.b/vfs_blobs/ab/abcd.ID.tmp');
  expect(blobTempPath('/data/vfs_blobs/ab/abcd.tar.gz', 'ID', path.posix)).toBe('/data/vfs_blobs/ab/abcd.tar.ID.tmp');
  expect(blobTempPath('/data/vfs_blobs/ab/.abcd', 'ID', path.posix)).toBe('/data/vfs_blobs/ab/.abcd.ID.tmp');
  expect(blobTempPath('C:\\Users\\a.b\\DeepStudent\\vfs_blobs\\ab\\abcd', 'ID', path.win32))
    .toBe('C:\\Users\\a.b\\DeepStudent\\vfs_blobs\\ab\\abcd.ID.tmp');
  expect(blobTempPath('C:\\Users\\a.b\\vfs_blobs\\ab\\abcd.pdf', 'ID', path.win32)).toBe('C:\\Users\\a.b\\vfs_blobs\\ab\\abcd.ID.tmp');
});

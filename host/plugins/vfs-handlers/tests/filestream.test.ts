import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HandlerPanic } from '../../../kernel/testing.ts';
import { createNodeFiles } from '../../../platform/files/index.ts';
import { checkAccess, extensionPermitted, hasHiddenSegmentWithin, isAllowedMediaExtension } from '../src/filestream.ts';
import { createVfsHost, type VfsHost } from './harness.ts';

describe('file_stream_protocol.rs access policy', () => {
  it('test_is_allowed_media_extension', () => {
    for (const extension of ['mp3', 'wav', 'MP4', 'JPG', 'pdf', 'bin', 'mkv', 'aiff', 'heic', 'flac', 'opus', 'aif', 'caf', 'mp4', '3gp', 'png', 'Png']) expect(isAllowedMediaExtension(extension)).toBe(true);
    for (const extension of ['exe', 'html', 'sh', 'db', 'json', '', 'txt', 'docx']) expect(isAllowedMediaExtension(extension)).toBe(false);
  });
  it('test_extension_permitted_relaxed_inside_blob_dirs', () => {
    expect(extensionPermitted('/app/blobs/hash', ['/app/blobs'])).toBe(true);
    expect(extensionPermitted('/app/blobs/hash.any', ['/app/blobs'])).toBe(true);
    expect(extensionPermitted('/app/blobs-sibling/hash', ['/app/blobs'])).toBe(false);
    expect(extensionPermitted('/docs/test.MP4', ['/app/blobs'])).toBe(true);
    expect(extensionPermitted('/docs/test.db', ['/app/blobs'])).toBe(false);
  });
  it('test_has_hidden_segment_within', () => {
    expect(hasHiddenSegmentWithin('/home/.local/share/app/image.png', ['/home/.local/share/app'])).toBe(false);
    expect(hasHiddenSegmentWithin('/home/.local/share/app/.secret/image.png', ['/home/.local/share/app'])).toBe(true);
    expect(hasHiddenSegmentWithin('/home/.local/share/app/media/.hidden.mp4', ['/home/.local/share/app'])).toBe(true);
    expect(hasHiddenSegmentWithin('/outside/image.png', ['/home/app'])).toBe(true);
    expect(hasHiddenSegmentWithin('/home/.app/blob/image.png', ['/home', '/home/.app/blob'])).toBe(false);
  });
  it('test_hidden_segment_check_with_mixed_verbatim_forms_on_windows', () => {
    expect(hasHiddenSegmentWithin('\\\\?\\C:\\App\\Blobs\\hash', ['C:\\App\\Blobs'], true)).toBe(false);
    expect(hasHiddenSegmentWithin('C:\\App\\Blobs\\.hidden\\hash', ['\\\\?\\C:\\App\\Blobs'], true)).toBe(true);
  });
  it('checks actual regular files through the file scope and rejects hidden/nonmedia paths', async () => {
    const root = mkdtempSync(join(tmpdir(), 'l13b-stream-'));
    try {
      const docs = join(root, 'docs'); const blobs = join(root, 'blobs');
      mkdirSync(docs); mkdirSync(blobs); mkdirSync(join(docs, '.hidden'));
      for (const file of [join(docs, '中文.mp4'), join(docs, 'secret.db'), join(docs, '.hidden', 'x.mp4'), join(blobs, 'hash')]) writeFileSync(file, 'data');
      const files = createNodeFiles({ roots: [{ name: 'temp', path: root }] });
      expect(await checkAccess(files, join(docs, '中文.mp4'), [docs, blobs], [blobs])).toBe(true);
      expect(await checkAccess(files, join(blobs, 'hash'), [docs, blobs], [blobs])).toBe(true);
      expect(await checkAccess(files, join(docs, 'secret.db'), [docs, blobs], [blobs])).toBe(false);
      expect(await checkAccess(files, join(docs, '.hidden', 'x.mp4'), [docs, blobs], [blobs])).toBe(false);
      expect(await checkAccess(files, join(docs, 'missing.mp4'), [docs, blobs], [blobs])).toBe(false);
      expect(await checkAccess(files, docs, [docs, blobs], [blobs])).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('file_stream_protocol.rs:719-741 filestream_check_access command', { timeout: 120_000 }, () => {
  const ops = (vfs: VfsHost, from: number) => vfs.host.shellRequests.slice(from).map(request => request.op);

  it('returns false before requesting Shell allowed dirs when canonicalize fails (empty or missing path)', async () => {
    // Rust: `let Ok(canonical) = std::fs::canonicalize(..) else { return Ok(false) }` precedes resolve_allowed_dirs.
    // std::fs::canonicalize("") fails; Node realpathSync('') would resolve to cwd.
    const vfs = await createVfsHost();
    try {
      for (const file of ['', join(vfs.root, 'absent', 'missing.mp4')]) {
        const start = vfs.host.shellRequests.length;
        expect(await vfs.host.invoke('filestream_check_access', { path: file }), JSON.stringify(file)).toBe(false);
        expect(ops(vfs, start), JSON.stringify(file)).toEqual([]);
      }
      // A resolvable path does need the Shell whitelist: without a Shell it is a missing runtime precondition, not `false`.
      writeFileSync(join(vfs.root, 'present.mp4'), 'data');
      const start = vfs.host.shellRequests.length;
      await expect(vfs.host.invoke('filestream_check_access', { path: join(vfs.root, 'present.mp4') }))
        .rejects.toBeInstanceOf(HandlerPanic);
      expect(ops(vfs, start)).toEqual(['app.pdfStreamAllowedDirs']);
    } finally { await vfs.dispose(); }
  });

  it('resolves the real Shell allowed dirs for existing paths and keeps whitelist/hidden/extension/blob/file checks', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'l13b-stream-outside-'));
    let docs = '';
    const vfs = await createVfsHost({ shell: op => {
      if (op === 'app.pdfStreamAllowedDirs') return [docs];
      throw new Error(`Unexpected shell operation: ${op}`);
    } });
    try {
      docs = join(vfs.root, 'docs');
      const blobs = vfs.host.ctx.vfsDatabase.blobsDir();
      mkdirSync(join(docs, '.hidden'), { recursive: true });
      mkdirSync(blobs, { recursive: true });
      const cases: [string, boolean][] = [
        [join(docs, '中文.mp4'), true],
        [join(blobs, 'hash'), true],
        [join(docs, 'secret.db'), false],
        [join(docs, '.hidden', 'x.mp4'), false],
        [join(outside, 'x.mp4'), false],
      ];
      for (const [file] of cases) writeFileSync(file, 'data');
      for (const [file, expected] of [...cases, [docs, false] as [string, boolean]]) {
        const start = vfs.host.shellRequests.length;
        expect(await vfs.host.invoke('filestream_check_access', { path: file }), file).toBe(expected);
        expect(ops(vfs, start), file).toEqual(['app.pdfStreamAllowedDirs']);
      }
    } finally {
      await vfs.dispose();
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

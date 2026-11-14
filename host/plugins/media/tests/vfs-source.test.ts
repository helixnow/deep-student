/**
 * `loadVfsFileBytes` (`docx_executor.rs:318-375` and the pptx/xlsx copies): a synced `files.original_path`
 * is only read back when it still holds the file recorded at import.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { sha256HexSync } from '../../../platform/crypto/sync.ts';
import type { VfsDatabase } from '../../vfs/api.ts';
import { loadVfsFileBytes, type VfsFileRepos } from '../src/tools/vfs-source.ts';

const RECORDED = Buffer.from('recorded docx bytes');
const SECRET = Buffer.from('secret');

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'w04-vfs-source-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function write(name: string, bytes: Uint8Array): string {
  const file = path.join(root, name);
  fs.writeFileSync(file, bytes);
  return file;
}

function load(row: { originalPath?: string; blobHash?: string; sha256: string }, blobs: Record<string, string> = {}) {
  const warnings: string[] = [];
  const database = { getConnSafe: () => ({}), blobsDir: () => root } as unknown as VfsDatabase;
  const repos = {
    files: { getFile: () => row },
    blobs: { getBlobPath: (_conn: unknown, _dir: string, hash: string) => blobs[hash] ?? null },
  } as unknown as VfsFileRepos;
  const log = { warn: (message: string) => { warnings.push(message); }, debug() {} };
  return { warnings, bytes: loadVfsFileBytes(database, repos, 'file_1', 'DocxToolExecutor', log) };
}

it('RF-W04-office-original-path-content: an original_path holding the recorded file is still read', async () => {
  const digest = sha256HexSync(RECORDED);
  const original = write('lesson.docx', RECORDED);
  for (const sha256 of [digest, digest.toUpperCase(), `${digest}_copy_file_0`]) {
    const { bytes, warnings } = load({ originalPath: original, sha256 });
    expect(Buffer.from(await bytes).toString()).toBe(RECORDED.toString());
    expect(warnings).toEqual([]);
  }
});

it('RF-W04-office-original-path-content: an original_path naming other content is skipped for the blobs', async () => {
  const digest = sha256HexSync(RECORDED);
  const secret = write('secret.txt', SECRET);
  const blob = write('blob.bin', RECORDED);

  const fallback = load({ originalPath: secret, blobHash: 'h1', sha256: digest }, { h1: blob });
  expect(Buffer.from(await fallback.bytes).toString()).toBe(RECORDED.toString());
  expect(fallback.warnings).toEqual([
    `[DocxToolExecutor] Ignoring original_path whose content is not the recorded file: ${secret}`,
  ]);

  for (const sha256 of [digest, 'not-a-digest', '']) {
    await expect(load({ originalPath: secret, sha256 }).bytes)
      .rejects.toThrow('无法加载文件内容: file_1 (无可用 blob_hash 或 original_path)');
  }
});

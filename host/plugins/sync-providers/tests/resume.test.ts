import './local-fs-fixture.ts';
import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { destResumeLen, persistDownload, contentKeyedPartPath, cleanupStaleParts } from '../src/resume.ts';

const dirs: string[] = [];
async function tempdir() { const dir = await mkdtemp(join(tmpdir(), 'sync-resume-')); dirs.push(dir); return dir; }
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

it('dest_resume_len_keeps_valid_prefix_and_drops_oversize', async () => {
  const dir = await tempdir();
  expect(await destResumeLen(join(dir, 'none'), 100)).toBe(0);
  const ok = join(dir, 'ok');
  await writeFile(ok, new Uint8Array(40).fill(1));
  expect(await destResumeLen(ok, 100)).toBe(40);
  await expect(access(ok)).resolves.toBeUndefined();
  const over = join(dir, 'over');
  await writeFile(over, new Uint8Array(200).fill(1));
  expect(await destResumeLen(over, 100)).toBe(0);
  await expect(access(over)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('persist_download_replaces_existing_dest_without_appending', async () => {
  const dir = await tempdir();
  const dest = join(dir, 'live.db'), part = join(dir, '.live.db.ds-dl.part');
  await writeFile(dest, 'OLD-CONTENT-SHOULD-GO');
  await writeFile(part, 'NEW');
  await persistDownload(part, dest);
  expect(await readFile(dest)).toEqual(Buffer.from('NEW'));
  await expect(access(part)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('content_keyed_part_path_isolates_versions', () => {
  const dest = join(tmpdir(), 'workspace.db');
  const a = contentKeyedPartPath(dest, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  const b = contentKeyedPartPath(dest, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  expect(a).not.toBe(b);
  expect(basename(a)).toContain('aaaaaaaaaaaaaaaa');
  expect(basename(a).endsWith('.ds-dl.part')).toBe(true);
  expect(basename(contentKeyedPartPath(dest, 'not-hex'))).toBe('.workspace.db.unknown.ds-dl.part');
});

it('cleanup_stale_parts_keeps_only_current_hash', async () => {
  const dir = await tempdir(), dest = join(dir, 'asset.bin');
  const keep = contentKeyedPartPath(dest, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  const stale = contentKeyedPartPath(dest, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  const unrelated = join(dir, '.other.bin.cccccccc.ds-dl.part');
  await writeFile(keep, 'keep'); await writeFile(stale, 'stale'); await writeFile(unrelated, 'other');
  await cleanupStaleParts(dest, keep);
  await expect(access(keep)).resolves.toBeUndefined();
  await expect(access(stale)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(access(unrelated)).resolves.toBeUndefined();
});

import './local-runtime-fixture.ts';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { encodeAssetKeySegments } from '../src/asset-filenames.ts';
import { classifyBlobs, classifyAssets, mergeBlobManifests, mergeAssetManifests, type BlobEntry, type AssetEntry } from '../src/unsynced-classification.ts';

const dirs: string[] = [];
function directory() { const dir = mkdtempSync(join(tmpdir(), 'sync-unsynced-')); dirs.push(dir); return dir; }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const blob = (path: string, cipher: string | null, updated = '2026-08-24T00:00:00Z'): BlobEntry => ({
  relative_path: path, size: 1n, updated_at: updated, cipher_sha256: cipher,
});
const asset = (sha: string, cipher: string | null): AssetEntry => ({
  sha256: sha, size: 1n, updated_at: '2026-08-24T00:00:00Z', cipher_sha256: cipher, revision: 0n,
});

it('classify_blobs_distinguishes_present_pending_and_legacy_plaintext', () => {
  const dir = join(directory(), 'vfs_blobs');
  mkdirSync(join(dir, 'ab'), { recursive: true });
  writeFileSync(join(dir, 'ab/present.bin'), 'x');
  const manifest = { updated_at: '', entries: new Map([
    ['hash-present', blob('ab/present.bin', 'c1')], ['hash-missing', blob('cd/missing.bin', 'c2')],
    ['hash-legacy', blob('ef/legacy.bin', null)], ['hash-evil', blob('../escape.bin', 'c3')],
  ]) };
  const kinds = new Map(classifyBlobs(manifest, dir, true).map(item => [item.key, item.kind]));
  expect(kinds.has('hash-present')).toBe(false);
  expect(kinds.get('hash-missing')).toBe('downloadPending');
  expect(kinds.get('hash-legacy')).toBe('legacyPlaintext');
  expect(kinds.get('hash-evil')).toBe('invalidKey');
  const plain = new Map(classifyBlobs(manifest, dir, false).map(item => [item.key, item.kind]));
  expect(plain.get('hash-legacy')).toBe('downloadPending');
});

it('classify_assets_reports_case_conflict_sanitized_conflict_and_invalid_key', () => {
  const dir = directory(); const active = join(dir, 'active'); const app = join(dir, 'app_data');
  mkdirSync(join(active, 'images'), { recursive: true });
  writeFileSync(join(active, 'images/Photo.PNG'), 'local');
  const encoded = encodeAssetKeySegments('active', 'documents', ['report?.md']);
  const manifest = { updated_at: '', entries: new Map([
    ['active/images/Photo.PNG', asset('sha-local', 'c1')], ['active/images/photo.png', asset('sha-other', 'c2')],
    ['active/documents/report?.md', asset('sha-a', 'c3')], [encoded, asset('sha-b', 'c4')],
    ['active/only-two', asset('sha-c', 'c5')], ['active/audio/lecture.mp3', asset('sha-d', 'c6')],
    ['active/videos/old.mp4', asset('sha-e', null)],
  ]) };
  const items = classifyAssets(manifest, active, app, true);
  const kinds = new Map(items.map(item => [item.key, item.kind]));
  expect(kinds.has('active/images/Photo.PNG')).toBe(false);
  expect(kinds.get('active/images/photo.png')).toBe('caseConflict');
  expect(items.find(item => item.key === 'active/images/photo.png')!.counterpart).toBe('active/images/Photo.PNG');
  expect(kinds.get('active/documents/report?.md')).toBe('sanitizedNameConflict');
  expect(kinds.get('active/only-two')).toBe('invalidKey');
  expect(kinds.get('active/audio/lecture.mp3')).toBe('downloadPending');
  expect(kinds.get('active/videos/old.mp4')).toBe('legacyPlaintext');
});

it('merge_blob_manifests_prefers_cipher_entries_over_plaintext', () => {
  const older = { updated_at: '', entries: new Map([['h1', blob('ab/a.bin', 'cipher', '2026-08-01T00:00:00Z')]]) };
  const newer = { updated_at: '', entries: new Map([['h1', blob('ab/a.bin', null, '2026-08-20T00:00:00Z')]]) };
  expect(mergeBlobManifests([older, newer]).entries.get('h1')!.cipher_sha256).not.toBeNull();
});

it('merge_asset_manifests_higher_revision_wins', () => {
  const low = { updated_at: '', entries: new Map([['active/images/a.png', { ...asset('sha-old', null), revision: 1n }]]) };
  const high = { updated_at: '', entries: new Map([['active/images/a.png', { ...asset('sha-new', null), revision: 3n }]]) };
  expect(mergeAssetManifests([high, low]).entries.get('active/images/a.png')!.sha256).toBe('sha-new');
});

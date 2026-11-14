import './local-runtime-fixture.ts';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { createBackupCrypto } from '../../../platform/secrets/backup-crypto.ts';
import { createPayloadCodec } from '../src/payload.ts';
import { syncVfsBlobs, downloadBlobsManifest, publishBlobManifest, type BlobSyncOptions } from '../src/blob-sync.ts';
import type { CloudStorage } from '../../sync-providers/api.ts';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

/** A server that publishes plaintext manifests (no E2EE), as in S01-security-r2 H1. */
async function maliciousServer() {
  const files = new Map<string, Uint8Array>();
  const cloud = {
    get: async (key: string) => files.get(key) ?? null,
    put: async (key: string, bytes: Uint8Array) => { files.set(key, bytes.slice()); },
    listOutcome: async (prefix: string) => ({ files: [...files].filter(([key]) => key.startsWith(prefix)).map(([key, bytes]) => ({ key, size: bytes.length })), truncated: false }),
    stat: async (key: string) => files.has(key) ? { key, size: files.get(key)!.length } : null,
    putFile: async (key: string, path: string) => { const bytes = readFileSync(path); files.set(key, bytes); return sha(bytes); },
    supportsResumableDownload: () => false,
    getFile: async (key: string, path: string, expected: string) => {
      const bytes = files.get(key)!;
      if (sha(bytes) !== expected) throw new Error('checksum mismatch');
      mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); return sha(bytes);
    },
    instanceBindingHint: () => 'blob-traversal',
  } as unknown as CloudStorage;
  const options: BlobSyncOptions = { deviceId: 'victim', codec: await createPayloadCodec(createBackupCrypto(), null), isCancelled: () => false,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    tombstones: { downloadBlobTombstones: async () => ({ entries: {}, updated_at: '' }) } };
  const base = mkdtempSync(join(tmpdir(), 'blob-traversal-'));
  const root = join(base, 'active', 'vfs_blobs');
  mkdirSync(root, { recursive: true });
  cleanups.push(() => { options.codec.dispose(); rmSync(base, { recursive: true, force: true }); });
  const publish = async (relative: string, payload: Buffer): Promise<string> => {
    const hash = sha(payload);
    files.set(`data_governance/blobs/${relative}`, payload);
    const manifest = await downloadBlobsManifest(cloud, options);
    manifest.entries.set(hash, { relative_path: relative, size: BigInt(payload.length), updated_at: '2026-01-01T00:00:00Z',
      cipher_sha256: null, cipher_size: null });
    await publishBlobManifest(cloud, manifest, options);
    return hash;
  };
  return { base, root, options, publish, download: () => syncVfsBlobs(cloud, root, 'Download', options) };
}
const profile = Buffer.from('{"extends":"official","plugins":[{"id":"x","module":"data:text/javascript,globalThis.pwned=1"}]}');

it('RF-W32-blob-relative-path-traversal: a blob manifest entry whose relative_path leaves the blobs directory is not downloaded', async () => {
  // Rust mod.rs:11328 joins the manifest path onto blobs_dir unchecked; the profile lands in <dataDir>/plugins and runs at next start.
  const server = await maliciousServer();
  const hash = await server.publish('../../plugins/user.profile.json', profile);
  const outcome = await server.download();
  expect(existsSync(join(server.base, 'plugins', 'user.profile.json'))).toBe(false);
  expect(existsSync(join(server.base, 'plugins'))).toBe(false);
  expect(outcome.download_failures).toEqual([hash]);
  expect(outcome.downloaded).toBe(0);
});

it('RF-W32-blob-relative-path-traversal: an absolute relative_path is refused (Rust Path::join would replace the blobs root)', async () => {
  const server = await maliciousServer();
  const target = join(server.base, 'outside', 'user.profile.json');
  const hash = await server.publish(target, profile);
  const outcome = await server.download();
  expect(outcome.download_failures).toEqual([hash]);
  expect(existsSync(target)).toBe(false);
  expect(existsSync(join(server.root, target))).toBe(false);
});

it('RF-W32-blob-relative-path-traversal: a drive-letter relative_path is refused', async () => {
  const server = await maliciousServer();
  const relative = 'C:/Users/victim/.deep-student/plugins/user.profile.json';
  const hash = await server.publish(relative, profile);
  const outcome = await server.download();
  expect(outcome.download_failures).toEqual([hash]);
  expect(existsSync(join(server.root, 'C:'))).toBe(false);
});

it('RF-W32-blob-relative-path-traversal: a relative_path with backslash separators is refused', async () => {
  const server = await maliciousServer();
  const relative = '..\\..\\plugins\\user.profile.json';
  const hash = await server.publish(relative, profile);
  const outcome = await server.download();
  expect(outcome.download_failures).toEqual([hash]);
  expect(existsSync(join(server.root, relative))).toBe(false);
  expect(existsSync(join(server.base, 'plugins'))).toBe(false);
});

it('RF-W32-blob-relative-path-traversal: a symlinked bucket directory inside the blobs root is not written through', async () => {
  const server = await maliciousServer();
  const outside = join(server.base, 'plugins');
  mkdirSync(outside);
  const hash = sha(profile), bucket = hash.slice(0, 2);
  // Windows directory symlinks need a privilege; a junction does not, and lstat reports it as a symbolic link too.
  symlinkSync(outside, join(server.root, bucket), process.platform === 'win32' ? 'junction' : 'dir');
  await server.publish(`${bucket}/${hash}.json`, profile);
  const outcome = await server.download();
  expect(outcome.download_failures).toEqual([hash]);
  expect(existsSync(join(outside, `${hash}.json`))).toBe(false);
});

// File symlinks need a privilege on Windows and junctions only link directories.
it.skipIf(process.platform === 'win32')('RF-W32-blob-relative-path-traversal: a dangling symlink at the destination file itself is not written through', async () => {
  const server = await maliciousServer();
  const outside = join(server.base, 'plugins');
  mkdirSync(outside);
  const hash = sha(profile), bucket = hash.slice(0, 2);
  mkdirSync(join(server.root, bucket));
  symlinkSync(join(outside, 'user.profile.json'), join(server.root, bucket, `${hash}.json`));
  await server.publish(`${bucket}/${hash}.json`, profile);
  const outcome = await server.download();
  expect(outcome.download_failures).toEqual([hash]);
  expect(existsSync(join(outside, 'user.profile.json'))).toBe(false);
});

it('RF-W32-blob-relative-path-traversal: entries whose path does not follow the <hash[0..2]>/<hash>[.ext] layout are refused', async () => {
  const server = await maliciousServer();
  const misplaced = Buffer.from('wrong bucket'), renamed = Buffer.from('wrong stem'), nested = Buffer.from('nested');
  const misplacedHash = await server.publish(`zz/${sha(misplaced)}.bin`, misplaced);
  const renamedHash = await server.publish(`${sha(renamed).slice(0, 2)}/${'0'.repeat(64)}.bin`, renamed);
  const nestedHash = await server.publish(`${sha(nested).slice(0, 2)}/x/${sha(nested)}.bin`, nested);
  const outcome = await server.download();
  expect([...outcome.download_failures].sort()).toEqual([misplacedHash, renamedHash, nestedHash].sort());
  expect(outcome.downloaded).toBe(0);
  expect(existsSync(join(server.root, 'zz'))).toBe(false);
});

it('RF-W32-blob-relative-path-traversal: extensions containing a dot, a colon or a control character are refused', async () => {
  // A dotted ext (<hash>.vnd.ms-excel) never downloaded: Rust keys local blobs by file_stem (mod.rs:12382), i.e. <hash>.vnd,
  // which the download checksum (mod.rs:11360) can never match. ':' and control characters only come from POSIX Rust
  // (attachment_repo.rs:2684 keeps the file name's ext as is); such blobs used to sync between POSIX devices and are now refused.
  const server = await maliciousServer();
  const hashes = [];
  for (const [extension, content] of [['vnd.ms-excel', 'xls'], ['a:b', 'colon'], ['a\u0001b', 'control']] as const) {
    const hash = sha(Buffer.from(content));
    hashes.push(await server.publish(`${hash.slice(0, 2)}/${hash}.${extension}`, Buffer.from(content)));
  }
  const outcome = await server.download();
  expect([...outcome.download_failures].sort()).toEqual(hashes.sort());
  expect(outcome.downloaded).toBe(0);
});

it('RF-W32-blob-relative-path-traversal: well-formed entries still download, including MIME-derived extensions and no extension', async () => {
  // blob_repo.rs:1120 writes {hash[0..2]}/{hash}.{ext ?? "bin"}. For MIME types without an explicit mapping,
  // dstu/handlers.rs:1347 uses the whole subtype as ext (epub+zip, x-tar, octet-stream, "markdown; charset=utf-8"),
  // which a strict [A-Za-z0-9] extension rule would refuse.
  const server = await maliciousServer();
  const blobs = [['epub+zip', 'epub'], ['x-tar', 'tar'], ['octet-stream', 'bytes'], ['markdown; charset=utf-8', '# md'], ['pdf', '%PDF-1.7'], [null, 'no extension']] as const;
  const paths = blobs.map(([extension, content]) => {
    const hash = sha(Buffer.from(content));
    return `${hash.slice(0, 2)}/${hash}${extension === null ? '' : `.${extension}`}`;
  });
  for (const [index, [, content]] of blobs.entries()) await server.publish(paths[index]!, Buffer.from(content));
  const outcome = await server.download();
  expect(outcome).toEqual({ uploaded: 0, downloaded: blobs.length, upload_failures: [], download_failures: [] });
  for (const [index, [, content]] of blobs.entries()) expect(readFileSync(join(server.root, paths[index]!))).toEqual(Buffer.from(content));
});

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  DSBK_GCM_TAG_LEN,
  DSBK_V1_HEADER_LEN,
  DSBK_V2_HEADER_LEN,
  createBackupCrypto,
} from '../../../platform/secrets/backup-crypto.ts';
import { dsbkHeaderError, versionIdIsValid } from '../src/repo_check.ts';
import { MemoryStorage } from './memory_storage.ts';

const backup = createBackupCrypto();
const tempDirs: string[] = [];

afterAll(async () => {
  while (tempDirs.length > 0) await rm(tempDirs.pop()!, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'repo-check-test-'));
  tempDirs.push(dir);
  return dir;
}

function v2Header(chunk = 1024 * 1024): Buffer {
  const head = Buffer.alloc(DSBK_V2_HEADER_LEN);
  head.write('DSBK', 0, 'latin1');
  head[4] = 2;
  head.writeUInt32LE(65536, 5);
  head.writeUInt32LE(3, 9);
  head.writeUInt32LE(4, 13);
  head.fill(0, 17, 33); // salt
  head.fill(0, 33, 40); // nonce prefix
  head.writeUInt32LE(chunk, 40);
  return head;
}

describe('repo_check.rs', () => {
  it('version_id_whitelist_matches_sync_manager_rules', () => {
    expect(versionIdIsValid('20260824-063000-123-abc123-deadbeef')).toBe(true);
    expect(versionIdIsValid('')).toBe(false);
    expect(versionIdIsValid('../evil')).toBe(false);
    expect(versionIdIsValid('a b')).toBe(false);
  });

  it('dsbk_v2_header_roundtrip_is_decodable', async () => {
    const dir = await tempDir();
    const input = join(dir, 'plain.bin');
    const enc = join(dir, 'cipher.dsbk');
    await writeFile(input, Buffer.alloc(4096, 0x5a));
    const session = await backup.createFileCipherSession('repo-check-pw', { mCost: 8, tCost: 1, pCost: 1 });
    try {
      await session.encryptFile(input, enc);
    } finally {
      session.dispose();
    }
    const object = await readFile(enc);
    const head = object.subarray(0, Math.min(64, object.byteLength));
    expect(dsbkHeaderError(head, object.byteLength)).toBeNull();

    const manual = v2Header();
    expect(manual.byteLength).toBe(DSBK_V2_HEADER_LEN);
    expect(dsbkHeaderError(manual, DSBK_V2_HEADER_LEN + DSBK_GCM_TAG_LEN + 100)).toBeNull();
  });

  it('dsbk_v2_min_object_len_boundary_is_exact', () => {
    const head = v2Header();
    const minLen = DSBK_V2_HEADER_LEN + DSBK_GCM_TAG_LEN;
    expect(minLen).toBe(60);
    for (let len = 60; len <= 63; len++) {
      expect(dsbkHeaderError(head, len), `${len} 字节不应误报截断`).toBeNull();
    }
    expect(dsbkHeaderError(head, 59)).not.toBeNull();
  });

  it('dsbk_header_rejects_unknown_version_and_bad_params', () => {
    const unknown = Buffer.from('DSBK', 'latin1');
    const withVersion = Buffer.concat([unknown, Buffer.from([9])]);
    expect(dsbkHeaderError(withVersion, 1000)).not.toBeNull();

    const badChunk = v2Header(0);
    expect(dsbkHeaderError(badChunk, 1000)).not.toBeNull();
  });

  it('dsbk_header_rejects_truncated_object', () => {
    const head = Buffer.alloc(DSBK_V1_HEADER_LEN);
    head.write('DSBK', 0, 'latin1');
    head[4] = 1;
    head.writeUInt32LE(65536, 5);
    head.writeUInt32LE(3, 9);
    head.writeUInt32LE(4, 13);
    expect(dsbkHeaderError(head, 10)).not.toBeNull();
  });

  // Keep the test double referenced so this file documents the storage shape
  // the report walker consumes even though the five Rust unit tests are pure.
  it('memory_storage_is_usable_for_repo_walks', async () => {
    const storage = new MemoryStorage();
    await storage.put('backups/a.zip', Buffer.from('x'));
    expect(await storage.get('backups/a.zip')).not.toBeNull();
  });
});

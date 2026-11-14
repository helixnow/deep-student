import { describe, expect, it } from 'vitest';
import {
  BACKUP_V2_FORMAT,
  DELTA_FORMAT_VERSION,
  MAX_LOGICAL_PATH_BYTES,
  MAX_OBJECT_KEY_BYTES,
  SNAPSHOT_V2_FORMAT,
  decodeBackupV2RepoConfig,
  decodeSnapshotDescriptor,
  encodeBackupV2RepoConfig,
  encodeSnapshotDescriptor,
  validateSnapshotDescriptor,
  type BackupV2RepoConfig,
  type SnapshotDescriptorV2,
  type SnapshotFileRefV2,
} from '../src/delta_format.ts';

const HEX_A = 'a'.repeat(64);
const HEX_B = 'b'.repeat(64);

function fileRef(path: string, size = 1): SnapshotFileRefV2 {
  return {
    logicalPath: path,
    size,
    plaintextSha256: HEX_A,
    objectKey: `backup-v2/objects/device-1/${path.replaceAll('/', '-')}.dsbk`,
    objectCipherSha256: HEX_B,
  };
}

function descriptor(files: SnapshotFileRefV2[]): SnapshotDescriptorV2 {
  return {
    format: SNAPSHOT_V2_FORMAT,
    formatVersion: DELTA_FORMAT_VERSION,
    versionId: '20260824-140000-000-abc123-deadbeef',
    deviceId: 'device-1',
    createdAt: '2026-08-24T14:00:00+00:00',
    files,
    logicalSize: files.reduce((sum, file) => sum + file.size, 0),
  };
}

function repoConfig(): BackupV2RepoConfig {
  return { format: BACKUP_V2_FORMAT, formatVersion: DELTA_FORMAT_VERSION, idKeyEpoch: 1 };
}

describe('delta_format.rs', () => {
  it('descriptor round-trip is lossless, including empty snapshots', () => {
    const original = descriptor([
      fileRef('db/chat_v2.db', 1024),
      fileRef('assets/图片 01.png', 0),
      fileRef('assets/notes.bin', 0xffff_ffff),
    ]);
    expect(decodeSnapshotDescriptor(encodeSnapshotDescriptor(original))).toEqual(original);
    const empty = descriptor([]);
    expect(decodeSnapshotDescriptor(encodeSnapshotDescriptor(empty))).toEqual(empty);
  });

  it('repository config round-trip is lossless', () => {
    const original = repoConfig();
    expect(decodeBackupV2RepoConfig(encodeBackupV2RepoConfig(original))).toEqual(original);
  });

  it('encoded field names are camelCase', () => {
    const text = Buffer.from(encodeSnapshotDescriptor(descriptor([fileRef('a.bin')]))).toString('utf8');
    for (const field of [
      '"format"', '"formatVersion"', '"versionId"', '"deviceId"', '"createdAt"',
      '"files"', '"logicalSize"', '"logicalPath"', '"plaintextSha256"',
      '"objectKey"', '"objectCipherSha256"',
    ]) {
      expect(text).toContain(field);
    }
  });

  it('future and past format versions are rejected', () => {
    const future = descriptor([fileRef('a.bin')]);
    future.formatVersion = 3;
    expect(() => encodeSnapshotDescriptor(future)).toThrow();
    const json = Buffer.from(JSON.stringify(future));
    expect(() => decodeSnapshotDescriptor(json)).toThrow();

    const past = descriptor([]);
    past.formatVersion = 1;
    expect(() => encodeSnapshotDescriptor(past)).toThrow();

    const config = repoConfig();
    config.formatVersion = 3;
    expect(() => decodeBackupV2RepoConfig(Buffer.from(JSON.stringify(config)))).toThrow();
  });

  it('wrong format strings are rejected', () => {
    const wrong = descriptor([]);
    wrong.format = 'snapshot-v3';
    expect(() => encodeSnapshotDescriptor(wrong)).toThrow();
    const config = repoConfig();
    config.format = 'backup-v1';
    expect(() => encodeBackupV2RepoConfig(config)).toThrow();
  });

  it('parent/patch fields are rejected instead of ignored', () => {
    const encoded = JSON.parse(Buffer.from(encodeSnapshotDescriptor(descriptor([fileRef('a.bin')]))).toString('utf8'));
    encoded.parent = '20260101-000000-000-old-version';
    expect(() => decodeSnapshotDescriptor(Buffer.from(JSON.stringify(encoded)))).toThrow(/unknown field/);
    delete encoded.parent;
    encoded.patchOf = 'base-version';
    expect(() => decodeSnapshotDescriptor(Buffer.from(JSON.stringify(encoded)))).toThrow(/unknown field/);
  });

  it('repository config refuses key material and zero epoch', () => {
    const encoded = JSON.parse(Buffer.from(encodeBackupV2RepoConfig(repoConfig())).toString('utf8'));
    encoded.wrappedIdKey = 'base64-key-material';
    expect(() => decodeBackupV2RepoConfig(Buffer.from(JSON.stringify(encoded)))).toThrow(/unknown field/);

    const zero = repoConfig();
    zero.idKeyEpoch = 0;
    expect(() => encodeBackupV2RepoConfig(zero)).toThrow();
  });

  it('logical path traversal is rejected', () => {
    for (const bad of [
      '../escape.bin', 'a/../b.bin', '..', '/abs/path.bin', 'a//b.bin', 'a/', '/', '',
      'a\\b.bin', 'a/./b.bin', 'c:/windows.bin', 'a/\u0000null.bin',
    ]) {
      expect(() => encodeSnapshotDescriptor(descriptor([fileRef(bad)])), bad).toThrow();
    }
  });

  it('object key traversal is rejected', () => {
    for (const bad of [
      '../../manifests/device.json', '/backup-v2/objects/x.dsbk',
      'backup-v2/objects/../../marker', 'backup-v2//objects/x.dsbk',
      'backup-v2\\objects\\x.dsbk', '',
    ]) {
      const file = fileRef('a.bin');
      file.objectKey = bad;
      expect(() => encodeSnapshotDescriptor(descriptor([file])), bad).toThrow();
    }
  });

  it('path and object key length limits reject instead of truncating', () => {
    const atLimit = `d/${'p'.repeat(MAX_LOGICAL_PATH_BYTES - 2)}`;
    expect(Buffer.byteLength(atLimit)).toBe(MAX_LOGICAL_PATH_BYTES);
    const file = fileRef(atLimit);
    file.objectKey = 'backup-v2/objects/device-1/fixed.dsbk';
    expect(() => validateSnapshotDescriptor(descriptor([file]))).not.toThrow();

    const over = `d/${'p'.repeat(MAX_LOGICAL_PATH_BYTES - 1)}`;
    const overFile = fileRef(over);
    overFile.objectKey = 'backup-v2/objects/device-1/fixed.dsbk';
    expect(() => encodeSnapshotDescriptor(descriptor([overFile]))).toThrow(String(MAX_LOGICAL_PATH_BYTES));

    const longKey = fileRef('a.bin');
    longKey.objectKey = `k/${'o'.repeat(MAX_OBJECT_KEY_BYTES - 1)}`;
    expect(() => encodeSnapshotDescriptor(descriptor([longKey]))).toThrow();
  });

  it('duplicate logical paths and logicalSize mismatches are rejected', () => {
    expect(() => encodeSnapshotDescriptor(descriptor([
      fileRef('dup/a.bin', 1), fileRef('dup/a.bin', 2),
    ]))).toThrow(/重复/);

    const mismatch = descriptor([fileRef('a.bin', 10), fileRef('b.bin', 20)]);
    mismatch.logicalSize = 31;
    expect(() => encodeSnapshotDescriptor(mismatch)).toThrow();
    expect(() => decodeSnapshotDescriptor(Buffer.from(JSON.stringify(mismatch)))).toThrow();
    mismatch.logicalSize = 30;
    expect(() => validateSnapshotDescriptor(mismatch)).not.toThrow();
  });

  it('invalid hex digests are rejected', () => {
    for (const bad of ['aaaa', HEX_A.slice(0, 63), `${HEX_A}a`, `${HEX_A.slice(0, 63)}g`, `${HEX_A.slice(0, 63)}中`, '']) {
      const plain = fileRef('a.bin');
      plain.plaintextSha256 = bad;
      expect(() => encodeSnapshotDescriptor(descriptor([plain])), bad).toThrow();
      const cipher = fileRef('a.bin');
      cipher.objectCipherSha256 = bad;
      expect(() => encodeSnapshotDescriptor(descriptor([cipher])), bad).toThrow();
    }
  });
});

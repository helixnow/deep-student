/**
 * [R4-P04/P05] serde-equivalent manifest decoding and nanosecond merge order.
 *
 * Rust `CloudManifest`/`BackupVersion` are `serde_json` types: every required
 * field, integer token/range and RFC 3339 timestamp is validated before business
 * validation, duplicate struct fields are rejected, timestamps normalize to UTC
 * and serialize with `Z`, and `u64` stays exact until the IPC boundary.
 */

import { describe, expect, it } from 'vitest';
import { CloudStorageError } from '../src/errors.ts';
import {
  decodeManifest,
  emptyManifest,
  encodeManifest,
  mergeManifest,
  toWireVersion,
  type CloudManifest,
  type ManifestVersion,
} from '../src/manifest.ts';

const KEY = 'manifests/x.json';
const CHECKSUM_A = 'a'.repeat(64);
const CHECKSUM_B = 'b'.repeat(64);

function version(overrides: Partial<ManifestVersion> = {}): ManifestVersion {
  return {
    id: 'version-a',
    timestamp: '2026-01-01T00:00:00Z',
    size: 12n,
    checksum: CHECKSUM_A,
    deviceId: 'device-a',
    ...overrides,
  };
}

function manifest(overrides: Partial<CloudManifest> = {}): CloudManifest {
  return {
    version: 1,
    latest: 'version-a',
    versions: [version()],
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function decodeRaw(text: string): CloudManifest {
  return decodeManifest(KEY, Buffer.from(text, 'utf8'));
}

function failure(input: Uint8Array | string): CloudStorageError {
  try {
    decodeManifest(KEY, typeof input === 'string' ? Buffer.from(input, 'utf8') : input);
  } catch (error) {
    if (error instanceof CloudStorageError) return error;
    throw error;
  }
  throw new Error('expected decodeManifest to reject');
}

function failureOf(value: unknown): CloudStorageError {
  const candidate = value as Partial<CloudManifest> | null;
  if (typeof candidate === 'object' && candidate !== null
    && typeof candidate.version === 'number' && typeof candidate.updatedAt === 'string'
    && Array.isArray(candidate.versions)) {
    return failure(encodeManifest(candidate as CloudManifest));
  }
  return failure(JSON.stringify(value));
}

describe('sync_manager.rs manifest serde decoding', () => {
  it('rejects a missing manifest version before validation can throw a TypeError', () => {
    const error = failureOf({ versions: [] });
    expect(error.value.error_type).toBe('Unknown');
    expect(error.message).toContain('manifest manifests/x.json 损坏');
    expect(error.message).toContain('missing field');
    expect(error.message).toMatch(/at line \d+ column \d+/);
  });

  it('rejects a missing updatedAt/versions/checksum/deviceId with a position', () => {
    const missingUpdatedAt = failureOf({ version: 1, versions: [] });
    expect(missingUpdatedAt.message).toContain('updatedAt');
    expect(missingUpdatedAt.message).toMatch(/at line \d+ column \d+/);

    const missingVersions = failureOf({ version: 1, updatedAt: '2026-01-01T00:00:00Z' });
    expect(missingVersions.message).toContain('versions');
    expect(missingVersions.message).toMatch(/at line \d+ column \d+/);

    const missingChecksum = failure(
      '{"version":1,"latest":"version-a","versions":[{"id":"version-a","timestamp":"2026-01-01T00:00:00Z","size":12,"deviceId":"device-a"}],"updatedAt":"2026-01-01T00:00:00Z"}',
    );
    expect(missingChecksum.message).toContain('checksum');
    const missingDeviceId = failure(
      `{"version":1,"latest":"version-a","versions":[{"id":"version-a","timestamp":"2026-01-01T00:00:00Z","size":12,"checksum":"${CHECKSUM_A}"}],"updatedAt":"2026-01-01T00:00:00Z"}`,
    );
    expect(missingDeviceId.message).toContain('deviceId');
  });

  it('rejects JSON float tokens for u32/u64 and string/negative sizes', () => {
    const floatSize = failure(rawManifest('1.0'));
    expect(floatSize.message).toContain('floating point `1.0`');
    expect(floatSize.message).toContain('u64');
    expect(floatSize.message).toMatch(/at line \d+ column \d+/);

    const floatVersion = failure('{"version":1.0,"latest":null,"versions":[],"updatedAt":"2026-01-01T00:00:00Z"}');
    expect(floatVersion.message).toContain('floating point `1.0`');
    expect(floatVersion.message).toContain('u32');

    expect(failure(rawManifest('-1')).message).toContain('u64');
    expect(failure(rawManifest('"12"')).message).toContain('u64');
    expect(failure(rawManifest('1.5')).message).toContain('u64');
    expect(failure(rawManifest('1e2')).message).toContain('u64');
  });

  it('accepts the full u64 range and keeps the size exact internally', () => {
    const decoded = decodeRaw(rawManifest('9007199254740993'));
    expect(decoded.versions[0]!.size).toBe(9007199254740993n);
    expect(toWireVersion(decoded.versions[0]!).size).toBe(Number(9007199254740993n));

    const maxU64 = decodeRaw(rawManifest('18446744073709551615'));
    expect(maxU64.versions[0]!.size).toBe(18446744073709551615n);
    // The exact token survives a save/read round trip.
    expect(encodeManifest(maxU64)).toContain('"size":18446744073709551615');
    expect(decodeRaw(encodeManifest(maxU64)).versions[0]!.size).toBe(18446744073709551615n);

    expect(failure(rawManifest('18446744073709551616')).message).toContain('u64');
  });

  it('rejects duplicate struct fields like serde derive', () => {
    const duplicateVersion = failure(
      '{"version":2,"version":1,"latest":"version-a","versions":[],"updatedAt":"2026-01-01T00:00:00Z"}',
    );
    expect(duplicateVersion.message).toContain('duplicate field `version`');
    expect(duplicateVersion.message).toMatch(/at line 1 column \d+/);

    const duplicateId = failure(
      `{"version":1,"latest":"version-a","versions":[{"id":"a","id":"b","timestamp":"2026-01-01T00:00:00Z","size":1,"checksum":"${CHECKSUM_A}","deviceId":"d"}],"updatedAt":"2026-01-01T00:00:00Z"}`,
    );
    expect(duplicateId.message).toContain('duplicate field `id`');
    expect(duplicateId.message).toMatch(/at line 1 column \d+/);
  });

  it('rejects an invalid RFC 3339 timestamp instead of accepting it', () => {
    expect(failureOf({ ...manifest(), versions: [{ ...version(), timestamp: 'invalid' }] }).message).toContain('timestamp');
    expect(failureOf({ ...manifest(), updatedAt: 'bad' }).message).toContain('updatedAt');
    expect(failureOf({ ...manifest(), versions: [{ ...version(), timestamp: '2026-02-30T00:00:00Z' }] }).message)
      .toContain('timestamp');
  });

  it('rejects invalid UTF-8, a leading BOM and trailing garbage like serde_json::from_slice', () => {
    expect(failure(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])).message).toContain('manifest');
    expect(failure(new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from('{}')])).message).toContain('manifest');
    expect(failure(`${rawManifest('12')}x`).message).toContain('trailing characters');
  });

  it('ignores unknown fields but keeps known optional fields', () => {
    const decoded = decodeRaw(JSON.stringify({
      version: 1,
      latest: 'version-a',
      unknownTopLevel: [1, 2, 3],
      versions: [{
        id: 'version-a',
        timestamp: '2026-01-01T00:00:00Z',
        size: 12,
        checksum: CHECKSUM_A,
        deviceId: 'device-a',
        appVersion: '1.2.3',
        note: 'note',
        recoveryKind: 'partial_archive',
        unknownField: { nested: true },
      }],
      updatedAt: '2026-01-01T00:00:00Z',
    }));
    expect(decoded.versions[0]!.appVersion).toBe('1.2.3');
    expect(decoded.versions[0]!.note).toBe('note');
    expect(decoded.versions[0]!.recoveryKind).toBe('partial_archive');
    expect('unknownField' in decoded.versions[0]!).toBe(false);
    expect('unknownTopLevel' in decoded).toBe(false);
  });

  it('treats null optional fields as None and normalizes timestamps to Z', () => {
    const empty = decodeRaw(JSON.stringify({
      version: 1,
      latest: null,
      versions: [],
      updatedAt: '2026-01-01T08:00:00.123456789+08:00',
    }));
    expect(empty.latest).toBeUndefined();
    expect(empty.updatedAt).toBe('2026-01-01T00:00:00.123456789Z');

    const decoded = decodeRaw(JSON.stringify({
      version: 1,
      latest: 'version-a',
      updatedAt: '2026-01-01T08:00:00.123456789+08:00',
      versions: [{
        id: 'version-a',
        timestamp: '2026-01-01t08:00:00.123456789+08:00',
        size: 12,
        checksum: CHECKSUM_A,
        deviceId: 'device-a',
        appVersion: null,
        note: null,
        recoveryKind: null,
      }],
    }));
    expect(decoded.updatedAt).toBe('2026-01-01T00:00:00.123456789Z');
    expect(decoded.versions[0]!.timestamp).toBe('2026-01-01T00:00:00.123456789Z');
    expect(decoded.versions[0]!.appVersion).toBeUndefined();
    expect(encodeManifest(decoded)).not.toContain('appVersion');
    expect(encodeManifest(decoded)).toContain('"updatedAt":"2026-01-01T00:00:00.123456789Z"');
  });

  it('merge_orders_by_nanosecond_timestamps_not_milliseconds', () => {
    const target = emptyManifest();
    target.updatedAt = '2026-11-04T00:00:00.123000001Z';
    const incoming: CloudManifest = {
      version: 1,
      latest: 'a',
      updatedAt: '2026-11-04T00:00:00.123999999Z',
      versions: [
        version({ id: 'z', checksum: CHECKSUM_A, timestamp: '2026-11-04T00:00:00.123000001Z' }),
        version({ id: 'a', checksum: CHECKSUM_B, timestamp: '2026-11-04T00:00:00.123999999Z' }),
      ],
    };
    mergeManifest(target, incoming);
    expect(target.latest).toBe('a');
    expect(target.versions.map(item => item.id)).toEqual(['a', 'z']);
    expect(target.updatedAt).toBe('2026-11-04T00:00:00.123999999Z');
  });

  it('ignores duplicate keys inside unknown fields and never treats __proto__ as a struct field', () => {
    // serde derive's `IgnoredAny` skips the whole unknown value; duplicate keys
    // inside it are never inspected by the derive visitor.
    const accepted = decodeRaw(
      '{"version":1,"latest":null,"versions":[],"updatedAt":"2026-01-01T00:00:00Z",'
      + '"extension":{"x":1,"x":2}}',
    );
    expect(accepted.version).toBe(1);

    // `__proto__` is an ordinary unknown key for serde; it must not leak into
    // the decoded object through a prototype chain and must not satisfy the
    // required `version` field.
    const error = failure('{"versions":[],"updatedAt":"2026-01-01T00:00:00Z","__proto__":{"version":1}}');
    expect(error.message).toContain('missing field `version`');
    expect(({} as { version?: unknown }).version).toBeUndefined();
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  it('reports serde-style type errors with the value and the value end position', () => {
    const input = '{"version":1,"latest":null,"versions":[],"updatedAt":false}';
    const error = failure(input);
    // `DateTime<Utc>` uses chrono's DateTimeVisitor (chrono 0.4.41 datetime/serde.rs:58-60).
    expect(error.message).toContain('invalid type: boolean `false`, expected an RFC 3339 formatted date and time string');
    expect(error.message).not.toContain('for `updatedAt`');
    // serde_json positions point at the last consumed byte (byte-based column).
    expect(error.message).toContain(`at line 1 column ${input.indexOf('false') + 'false'.length}`);
  });

  // R4 ACCEPTANCE §13 counterexamples (serde_json 1.0.149 de.rs/read.rs, serde_derive 1.0.228 struct_.rs).
  it('rejects -0 for u32: serde_json parses it as F64(-0.0)', () => {
    const error = failure('{"version":-0,"versions":[],"updatedAt":"2026-01-01T00:00:00Z"}');
    expect(error.message).toBe(
      'manifest manifests/x.json 损坏: invalid type: floating point `-0.0`, expected u32 at line 1 column 13');
  });

  it('counts columns in UTF-8 bytes after a non-BMP character', () => {
    const input = '{"version":1,"versions":[],"ext":"😀","updatedAt":false}';
    const column = Buffer.byteLength(input.slice(0, input.indexOf('false') + 'false'.length));
    expect(column).toBe(57);
    expect(failure(input).message).toBe('manifest manifests/x.json 损坏: invalid type: boolean `false`, '
      + 'expected an RFC 3339 formatted date and time string at line 1 column 57');
  });

  it('reports a field type error before later trailing characters (streaming, end() runs last)', () => {
    const error = failure('{"version":false,"versions":[],"updatedAt":"2026-01-01T00:00:00Z"}x');
    expect(error.message).toBe(
      'manifest manifests/x.json 损坏: invalid type: boolean `false`, expected u32 at line 1 column 16');
  });

  it('reports a duplicate known field before parsing its second value', () => {
    const error = failure('{"version":1,"version":!,"versions":[],"updatedAt":"2026-01-01T00:00:00Z"}');
    expect(error.message).toBe('manifest manifests/x.json 损坏: duplicate field `version` at line 1 column 22');
  });

  it('formats rejected floats like serde_json (zmij) and classifies big integers as F64', () => {
    expect(failure(rawManifest('1e2')).message).toContain('invalid type: floating point `100.0`, expected u64');
    expect(failure(rawManifest('18446744073709551616')).message)
      .toContain('invalid type: floating point `1.8446744073709552e+19`, expected u64');
    expect(failure(rawManifest('-1')).message).toContain('invalid value: integer `-1`, expected u64');
    expect(failure(rawManifest('1e400')).message).toContain('number out of range');
  });

  it('reports a missing nested field at the nested object end, not the document end', () => {
    const versionJson = `{"id":"version-a","timestamp":"2026-01-01T00:00:00Z","size":12,"deviceId":"device-a"}`;
    const input = `{"version":1,"latest":null,"versions":[${versionJson}],"updatedAt":"2026-01-01T00:00:00Z"}`;
    const error = failure(input);
    expect(error.message).toContain('missing field `checksum`');
    const nestedEnd = input.indexOf(versionJson) + versionJson.length;
    expect(error.message).toContain(`at line 1 column ${nestedEnd}`);
    expect(nestedEnd).toBeLessThan(input.length);
  });

  it('merge_keeps_incoming_on_duplicate_id_and_tie_breaks_by_id_desc', () => {
    const target: CloudManifest = {
      version: 1,
      latest: 'same',
      updatedAt: '2026-01-01T00:00:00Z',
      versions: [version({ id: 'same', checksum: CHECKSUM_A }), version({ id: 'b', checksum: CHECKSUM_A })],
    };
    const incoming: CloudManifest = {
      version: 1,
      latest: 'same',
      updatedAt: '2026-01-01T00:00:00.000000001Z',
      versions: [
        version({ id: 'same', checksum: CHECKSUM_B }),
        version({ id: 'c', checksum: CHECKSUM_A, timestamp: '2026-01-02T00:00:00Z' }),
        version({ id: 'a', checksum: CHECKSUM_A, timestamp: '2026-01-02T00:00:00Z' }),
      ],
    };
    mergeManifest(target, incoming);
    expect(target.versions.map(item => item.id)).toEqual(['c', 'a', 'same', 'b']);
    expect(target.versions.find(item => item.id === 'same')!.checksum).toBe(CHECKSUM_B);
    expect(target.updatedAt).toBe('2026-01-01T00:00:00.000000001Z');
  });
});

function rawManifest(sizeToken: string): string {
  return `{"version":1,"latest":"version-a","versions":[{"id":"version-a","timestamp":"2026-01-01T00:00:00Z","size":${sizeToken},"checksum":"${CHECKSUM_A}","deviceId":"device-a"}],"updatedAt":"2026-01-01T00:00:00Z"}`;
}

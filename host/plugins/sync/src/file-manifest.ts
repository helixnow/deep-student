/** serde shapes from sync/mod.rs:477-604; integer fields never pass through Number. */
import { decodeUtf8Strict } from '../../../platform/util/index.ts';
import { isJsonObject, parseJsonLossless, type DbJson } from '../../../platform/util/lossless-json.ts';
import type { AssetEntry, BlobEntry, FileManifest } from './unsynced-classification.ts';

export interface WorkspaceEntry {
  sha256: string; size: bigint; updated_at: string; source_sha256: string | null;
  device_id: string | null; object_key: string | null; base_sha256: string | null;
  revision: bigint; cipher_sha256: string | null; cipher_size: bigint | null;
}

function object(value: DbJson | undefined): Record<string, DbJson> {
  if (!isJsonObject(value)) throw new Error('invalid type, expected a map');
  return value;
}
function text(value: DbJson | undefined, field: string, fallback?: string): string {
  if (value === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing field \`${field}\``);
  }
  if (typeof value !== 'string') throw new Error(`invalid type, expected a string for \`${field}\``);
  return value;
}
function uint(value: DbJson | undefined, field: string, fallback?: bigint): bigint {
  if (value === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing field \`${field}\``);
  }
  if (typeof value !== 'bigint' && !(typeof value === 'number' && Number.isSafeInteger(value))) {
    throw new Error(`invalid type, expected u64 for \`${field}\``);
  }
  const parsed = BigInt(value);
  if (parsed < 0n || parsed > 18446744073709551615n) throw new Error(`invalid value, expected u64 for \`${field}\``);
  return parsed;
}
function optionalText(value: DbJson | undefined, field: string): string | null {
  return value == null ? null : text(value, field);
}
function cipherFields(entry: Record<string, DbJson>) {
  return {
    cipher_sha256: optionalText(entry.cipher_sha256, 'cipher_sha256'),
    cipher_size: entry.cipher_size == null ? null : uint(entry.cipher_size, 'cipher_size'),
  };
}
function parseManifest<T>(bytes: Uint8Array, parseEntry: (entry: Record<string, DbJson>) => T): FileManifest<T> {
  const value = object(parseJsonLossless(decodeUtf8Strict(bytes)));
  if (!Object.hasOwn(value, 'entries')) throw new Error('missing field `entries`');
  return {
    entries: new Map(Object.entries(object(value.entries)).map(([key, entry]) => [key, parseEntry(object(entry))])),
    updated_at: text(value.updated_at, 'updated_at', ''),
  };
}
/**
 * Blob manifest entries are untrusted remote input. Parsing keeps them (the unsynced diagnostics report bad ones as
 * InvalidKey); every consumer that turns `relative_path` into a local path must pass it through this check first.
 */
// RUST-FIX(RF-W32-blob-relative-path-traversal): Rust joins the cloud relative_path onto blobs_dir unchecked (mod.rs:11328), so `../` or an absolute path writes anywhere; only the layout blob_repo.rs:1120 writes and tombstone.rs:1635 enforces is accepted.
export function blobRelativePathProblem(hash: string, relativePath: string): string | null {
  if (!/^[0-9a-f]{64}$/u.test(hash)) return '条目 hash 不是 64 位小写十六进制';
  if (relativePath === '' || relativePath.startsWith('/') || /[\\:\p{Cc}]/u.test(relativePath)) {
    return '相对路径为空、是绝对路径，或含反斜杠、盘符、控制字符';
  }
  const parts = relativePath.split('/');
  if (parts.length !== 2) return '相对路径必须恰好是 <hash 前两位>/<hash>[.扩展名] 两段';
  const [bucket, name] = parts as [string, string];
  const extension = name.startsWith(`${hash}.`) ? name.slice(hash.length + 1) : null;
  if (bucket !== hash.slice(0, 2) || !(name === hash || (extension !== null && !extension.includes('.')))) {
    return '相对路径与条目 hash 不一致';
  }
  return null;
}
export function parseBlobManifest(bytes: Uint8Array): FileManifest<BlobEntry> {
  return parseManifest(bytes, entry => ({
    relative_path: text(entry.relative_path, 'relative_path'), size: uint(entry.size, 'size'),
    updated_at: text(entry.updated_at, 'updated_at', ''), ...cipherFields(entry),
  }));
}
export function parseAssetManifest(bytes: Uint8Array): FileManifest<AssetEntry> {
  return parseManifest(bytes, entry => ({
    sha256: text(entry.sha256, 'sha256'), size: uint(entry.size, 'size'),
    updated_at: text(entry.updated_at, 'updated_at', ''), revision: uint(entry.revision, 'revision', 0n),
    object_key: optionalText(entry.object_key, 'object_key'), base_sha256: optionalText(entry.base_sha256, 'base_sha256'),
    device_id: optionalText(entry.device_id, 'device_id'), ...cipherFields(entry),
  }));
}

export function parseWorkspaceManifest(bytes: Uint8Array): FileManifest<WorkspaceEntry> {
  return parseManifest(bytes, entry => ({
    sha256: text(entry.sha256, 'sha256'), size: uint(entry.size, 'size'),
    updated_at: text(entry.updated_at, 'updated_at'), revision: uint(entry.revision, 'revision', 0n),
    source_sha256: optionalText(entry.source_sha256, 'source_sha256'),
    object_key: optionalText(entry.object_key, 'object_key'), base_sha256: optionalText(entry.base_sha256, 'base_sha256'),
    device_id: optionalText(entry.device_id, 'device_id'), ...cipherFields(entry),
  }));
}

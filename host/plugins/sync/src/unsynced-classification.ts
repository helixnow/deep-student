/** commands_sync.rs:5377-5805: read-only file diagnostics, before tombstone filtering. */
import { fs } from '../src/local-runtime.ts';
import { join, parse, sep } from '../../../platform/util/path.ts';
import { rustTrim } from '../../../platform/util/index.ts';
import { parseFlexibleTimestamp } from '../../../platform/time/index.ts';
import type { UnsyncedItemKind } from '../../../../contracts/ipc/generated/L20-sync.ts';
import { sanitizeAssetKey, casefoldKey, isSyncedAssetKey } from './asset-filenames.ts';
import { compareUtf8 } from '../../../platform/util/portable.ts';

export interface BlobEntry {
  relative_path: string;
  size: bigint;
  updated_at: string;
  cipher_sha256: string | null;
  cipher_size?: bigint | null;
}
export interface AssetEntry {
  sha256: string;
  size: bigint;
  updated_at: string;
  revision: bigint;
  cipher_sha256: string | null;
  cipher_size?: bigint | null;
  object_key?: string | null;
  base_sha256?: string | null;
  device_id?: string | null;
}
export interface FileManifest<T> { entries: Map<string, T>; updated_at: string }
export interface UnsyncedItem {
  kind: UnsyncedItemKind; scope: string; key: string; counterpart: string | null; size: bigint | null; detail: string;
}
const compare = (left: string, right: string): number => compareUtf8(left, right);

export function unsyncedTimestampAfter(candidate: string, reference: string): boolean {
  if (rustTrim(candidate) === '' || rustTrim(reference) === '') return false;
  const a = parseFlexibleTimestamp(candidate); const b = parseFlexibleTimestamp(reference);
  return a !== null && b !== null ? a.epochNanos > b.epochNanos : compare(candidate, reference) > 0;
}

export function mergeBlobManifests(manifests: readonly FileManifest<BlobEntry>[]): FileManifest<BlobEntry> {
  const merged: FileManifest<BlobEntry> = { entries: new Map(), updated_at: '' };
  for (const manifest of manifests) {
    if (compare(manifest.updated_at, merged.updated_at) > 0) merged.updated_at = manifest.updated_at;
    for (const [key, incoming] of manifest.entries) {
      const current = merged.entries.get(key);
      const replace = current === undefined ? true
        : current.cipher_sha256 === null && incoming.cipher_sha256 !== null ? true
        : current.cipher_sha256 !== null && incoming.cipher_sha256 === null ? false
        : unsyncedTimestampAfter(incoming.updated_at, current.updated_at);
      if (replace) merged.entries.set(key, { ...incoming });
    }
  }
  return merged;
}

export function mergeAssetManifests(manifests: readonly FileManifest<AssetEntry>[]): FileManifest<AssetEntry> {
  const merged: FileManifest<AssetEntry> = { entries: new Map(), updated_at: '' };
  for (const manifest of manifests) {
    if (compare(manifest.updated_at, merged.updated_at) > 0) merged.updated_at = manifest.updated_at;
    for (const [key, incoming] of manifest.entries) {
      const current = merged.entries.get(key);
      if (current === undefined || incoming.revision > current.revision
        || (incoming.revision === current.revision && unsyncedTimestampAfter(incoming.updated_at, current.updated_at))) {
        merged.entries.set(key, { ...incoming });
      }
    }
  }
  return merged;
}

/** Rust Path::components accepts interior '.'/duplicate separators but not leading CurDir. */
function ordinaryRelativePath(value: string): boolean {
  if (parse(value).root !== '') return false;
  const parts = value.split(sep === '\\' ? /[/\\]/u : '/');
  if (parts[0] === '.') return false;
  return !parts.includes('..') && parts.some(part => part !== '' && part !== '.');
}

function assetLocalPath(active: string, app: string, key: string): string | null {
  if (!isSyncedAssetKey(key)) return null;
  const first = key.indexOf('/'); const second = key.indexOf('/', first + 1);
  if (first < 0 || second < 0) return null;
  const root = key.slice(0, first); const top = key.slice(first + 1, second); const relative = key.slice(second + 1);
  if (!ordinaryRelativePath(top) || !ordinaryRelativePath(relative)) return null;
  const base = root === 'active' ? active : root === 'app_data' ? app : null;
  return base === null ? null : join(base, top, relative);
}

function pathExistsExact(path: string): boolean {
  if (!fs.existsSync(path)) return false;
  const root = parse(path).root;
  let current = root;
  for (const part of path.slice(root.length).split(sep).filter(Boolean)) {
    if (part === '.' || part === '..') return false;
    let entries: string[];
    try { entries = fs.readdirSync(current || '.'); }
    catch { return false; }
    if (!entries.includes(part)) return false;
    current = join(current, part);
  }
  return true;
}

export function classifyBlobs(manifest: FileManifest<BlobEntry>, blobsDir: string, encrypted: boolean): UnsyncedItem[] {
  const items: UnsyncedItem[] = [];
  for (const [key, entry] of manifest.entries) {
    const base = { scope: 'blob', key, counterpart: null, size: entry.size };
    if (!ordinaryRelativePath(entry.relative_path)) {
      items.push({ ...base, kind: 'invalidKey', detail: `blob 清单登记了非法相对路径 ${JSON.stringify(entry.relative_path)}，已拒绝落地` });
    } else if (!fs.existsSync(join(blobsDir, entry.relative_path))) {
      items.push(encrypted && entry.cipher_sha256 === null
        ? { ...base, kind: 'legacyPlaintext', detail: `云端对象 ${entry.relative_path} 是启用加密前上传的明文遗留对象，本端已启用端到端加密，防降级拒收` }
        : { ...base, kind: 'downloadPending', detail: `云端对象 ${entry.relative_path} 尚未成功下载到本设备` });
    }
  }
  return items;
}

export function classifyAssets(manifest: FileManifest<AssetEntry>, active: string, app: string, encrypted: boolean): UnsyncedItem[] {
  const items: UnsyncedItem[] = [];
  const canonicalToCloud = new Map<string, string>();
  for (const key of [...manifest.entries.keys()].sort(compare)) {
    const canonical = sanitizeAssetKey(key);
    if (canonical === null) {
      items.push({ kind: 'invalidKey', scope: 'asset', key, counterpart: null, size: manifest.entries.get(key)!.size,
        detail: '云端 key 结构非法（应为 root/目录/相对路径 三段），无法映射到本地' });
      continue;
    }
    // RUST-FIX(RF-W32-asset-top-allowlist): Rust reports keys outside the scanned directories as DownloadPending although syncing them would overwrite non-asset files.
    if (!isSyncedAssetKey(canonical)) {
      items.push({ kind: 'invalidKey', scope: 'asset', key, counterpart: null, size: manifest.entries.get(key)!.size,
        detail: '云端 key 不在同步的资产目录内，已拒绝落地' });
      continue;
    }
    const current = canonicalToCloud.get(canonical);
    if (current === undefined) { canonicalToCloud.set(canonical, key); continue; }
    const replace = key === canonical && current !== canonical;
    const [shadowed, kept] = replace ? [current, key] : [key, current];
    if (replace) canonicalToCloud.set(canonical, key);
    if (manifest.entries.get(shadowed)!.sha256 !== manifest.entries.get(kept)!.sha256) {
      items.push({ kind: 'sanitizedNameConflict', scope: 'asset', key: shadowed, counterpart: kept,
        size: manifest.entries.get(shadowed)!.size, detail: '与另一云端条目在文件名净化后重名且内容不同，本地无法同时物化' });
    }
  }
  const localExists = new Map<string, boolean>();
  for (const [canonical, key] of canonicalToCloud) {
    localExists.set(canonical, [canonical, key].some(candidate => {
      const path = assetLocalPath(active, app, candidate);
      return path !== null && pathExistsExact(path);
    }));
  }
  const canonicals = [...canonicalToCloud.keys()].sort(compare);
  const slots = new Map<string, string>();
  for (const canonical of canonicals) {
    const slot = casefoldKey(canonical);
    if (localExists.get(canonical) && !slots.has(slot)) slots.set(slot, canonical);
  }
  for (const canonical of canonicals) {
    const slot = casefoldKey(canonical);
    if (!slots.has(slot)) slots.set(slot, canonical);
  }
  for (const canonical of canonicals) {
    if (localExists.get(canonical)) continue;
    const key = canonicalToCloud.get(canonical)!; const entry = manifest.entries.get(key)!;
    const base = { scope: 'asset', key, counterpart: null, size: entry.size };
    if (assetLocalPath(active, app, canonical) === null) {
      items.push({ ...base, kind: 'invalidKey', detail: '净化后的 key 仍无法映射到本地安全路径，已拒绝落地' });
      continue;
    }
    const owner = slots.get(casefoldKey(canonical));
    if (owner !== undefined && owner !== canonical) {
      items.push({ ...base, kind: 'caseConflict', counterpart: owner,
        detail: '与另一文件仅文件名大小写不同，为避免在大小写不敏感的系统上互相覆盖已跳过下载' });
    } else if (encrypted && entry.cipher_sha256 === null) {
      items.push({ ...base, kind: 'legacyPlaintext', detail: '云端条目是启用加密前上传的明文遗留对象，本端已启用端到端加密，防降级拒收' });
    } else {
      items.push({ ...base, kind: 'downloadPending', detail: '云端条目尚未成功下载到本设备' });
    }
  }
  return items;
}

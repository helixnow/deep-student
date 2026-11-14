/** Asset alias/conflict-aware file synchronization, mod.rs:11600-12123. */
import { fs } from '../src/local-runtime.ts';
import { dirname } from '../../../platform/util/path.ts';
import { toRfc3339 } from '../../../platform/time/index.ts';
import { isCloudRateLimited, type CloudStorage } from '../../sync-providers/api.ts';
import type { FileSyncOutcome } from './blob-sync.ts';
import type { AssetEntry, FileManifest } from './unsynced-classification.ts';
import type { FileSyncDirection, FileTransferProgress } from './workspace-sync.ts';
import { localFileWins, saveConflictCopy } from './workspace-sync.ts';
import { compareFileText } from './workspace-manifest.ts';
import { scanAssets, assetLocalPath } from './asset-paths.ts';
import {
  ASSET_OBJECT_PREFIX, ASSET_LEGACY_PREFIX, downloadAssetsManifest, publishAssetManifest, validateAssetObjectKey, type AssetSyncOptions,
} from './asset-manifest.ts';
import { ensureFileUploadEncryptionPolicy, encryptUploadObject, putFileAndVerifySize, downloadFileObject } from './file-transfer.ts';
import {
  sanitizeAssetKey, legacySanitizedAssetKey, casefoldKey, localCaseConflictMessage, uploadCaseConflictMessage,
  downloadCaseConflictMessage, shadowedDivergentMessage, isSyncedAssetKey,
} from './asset-filenames.ts';
import { dbJsonEquals } from '../../../platform/util/lossless-json.ts';
import { SyncError } from './errors.ts';
import { isPortableAssetEnabled, supportsMobilePlugin } from './portable-assets.ts';

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const increment = (value: bigint) => value === 18446744073709551615n ? value : value + 1n;
function equal(a: AssetEntry, b: AssetEntry | undefined): boolean { return dbJsonEquals({ ...a }, b ? { ...b } : undefined); }
function clone(manifest: FileManifest<AssetEntry>): FileManifest<AssetEntry> {
  return { entries: new Map([...manifest.entries].map(([key, entry]) => [key, { ...entry }])), updated_at: manifest.updated_at };
}

export async function syncAssetDirectories(
  storage: CloudStorage, active: string, app: string, direction: FileSyncDirection, options: AssetSyncOptions,
  progress?: FileTransferProgress | null, excluded: ReadonlySet<string> = new Set(),
): Promise<FileSyncOutcome> {
  const cloud = await downloadAssetsManifest(storage, options);
  for (const key of excluded) cloud.entries.delete(key);
  const [local, scanConflicts] = await scanAssets(active, app, options);
  const canonicalToCloud = new Map<string, string>(), shadowed: [string, string][] = [];
  for (const key of [...cloud.entries.keys()].sort(compareFileText)) {
    const canonical = sanitizeAssetKey(key);
    if (canonical === null) throw new SyncError(`Database error: 拒绝非法、损坏或超长资产键，未推进文件同步: ${JSON.stringify(key)}`);
    // RUST-FIX(RF-W32-asset-top-allowlist): Rust downloads any cloud key (mod.rs:11962), overwriting e.g. active/databases/vfs.db; such entries are left in the manifest untouched.
    if (!isSyncedAssetKey(canonical)) { options.logger.warn(`[sync] 跳过同步资产目录之外的云端条目: ${JSON.stringify(key)}`); continue; }
    if (!isPortableAssetEnabled(canonical, options)) continue;
    const existing = canonicalToCloud.get(canonical);
    if (existing === undefined) canonicalToCloud.set(canonical, key);
    else if (key === canonical && existing !== canonical) { shadowed.push([existing, key]); canonicalToCloud.set(canonical, key); }
    else shadowed.push([key, existing]);
  }
  const cloudCasefold = new Map<string, string>();
  for (const key of [...canonicalToCloud.keys()].sort(compareFileText)) if (!cloudCasefold.has(casefoldKey(key))) cloudCasefold.set(casefoldKey(key), key);
  const next = clone(cloud), migrated = new Map<string, string>();
  const outcome: FileSyncOutcome = { uploaded: 0, downloaded: 0, upload_failures: [], download_failures: [] };
  const legacyCandidates = new Map<string, string[]>();
  for (const key of local.keys()) {
    const legacy = legacySanitizedAssetKey(key);
    if (legacy !== null && legacy !== key && !canonicalToCloud.has(key) && !local.has(legacy) && cloud.entries.has(legacy)) {
      const candidates = legacyCandidates.get(legacy) ?? []; candidates.push(key); legacyCandidates.set(legacy, candidates);
    }
  }
  const legacyOwners = new Map<string, string>();
  for (const [legacy, candidates] of legacyCandidates) {
    candidates.sort(compareFileText);
    if (candidates.length === 1) legacyOwners.set(candidates[0]!, legacy);
    else {
      const entry = cloud.entries.get(legacy)!;
      const matches = candidates.filter(key => local.get(key)!.sha256 === entry.sha256 && local.get(key)!.size === entry.size);
      if (matches.length === 1) legacyOwners.set(matches[0]!, legacy);
    }
  }
  const { codec, logger } = options;
  if (options.mobile) {
    const approved = new Set<string>();
    for (const [canonical, key] of canonicalToCloud) {
      if (!canonical.startsWith('app_data/plugins/') || !canonical.endsWith('/manifest.json')) continue;
      const entry = cloud.entries.get(key)!;
      const object = entry.object_key ?? `${ASSET_LEGACY_PREFIX}/${key}`;
      validateAssetObjectKey(object);
      const bytes = await storage.get(object);
      if (bytes && supportsMobilePlugin(JSON.parse(new TextDecoder().decode(await codec.decode(bytes))))) approved.add(canonical.slice(0, -'manifest.json'.length));
    }
    for (const key of canonicalToCloud.keys()) if (key.startsWith('app_data/plugins/') && ![...approved].some(prefix => key.startsWith(prefix))) canonicalToCloud.delete(key);
    const localApproved = new Set<string>();
    for (const [key, file] of local) if (key.startsWith('app_data/plugins/') && key.endsWith('/manifest.json')) {
      if (supportsMobilePlugin(JSON.parse(new TextDecoder().decode(fs.readFileSync(file.path))))) localApproved.add(key.slice(0, -'manifest.json'.length));
    }
    for (const key of local.keys()) if (key.startsWith('app_data/plugins/') && ![...localApproved].some(prefix => key.startsWith(prefix))) local.delete(key);
  }
  if (direction !== 'Download') {
    await ensureFileUploadEncryptionPolicy(storage, codec.encrypted);
    outcome.upload_failures.push(...scanConflicts);
    const groups = new Map<string, string[]>(), losers = new Map<string, string>();
    for (const key of local.keys()) { const group = groups.get(casefoldKey(key)) ?? []; group.push(key); groups.set(casefoldKey(key), group); }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      group.sort(compareFileText); const winner = group.find(key => canonicalToCloud.has(key)) ?? group[0]!;
      for (const key of group) if (key !== winner) losers.set(key, winner);
    }
    for (const key of [...local.keys()].sort(compareFileText)) {
      const file = local.get(key)!, winner = losers.get(key);
      if (winner !== undefined) { outcome.upload_failures.push(localCaseConflictMessage(key, winner)); continue; }
      const alias = cloud.entries.has(key) ? key : canonicalToCloud.get(key) ?? legacyOwners.get(key);
      if (alias === undefined) {
        const occupied = cloudCasefold.get(casefoldKey(key));
        if (occupied !== undefined && occupied !== key) { outcome.upload_failures.push(uploadCaseConflictMessage(key, occupied)); continue; }
      }
      const entry = alias === undefined ? undefined : cloud.entries.get(alias);
      const unchanged = entry && entry.sha256 === file.sha256 && entry.size === file.size;
      if (entry && !((unchanged && codec.encrypted && entry.cipher_sha256 === null) || (!unchanged && localFileWins(file.updated_at, entry.updated_at, file.sha256, entry.sha256)))) continue;
      let encrypted;
      try { encrypted = await encryptUploadObject(file.path, codec); }
      catch (error) { logger.warn(`[sync] 资产加密失败（跳过）: ${key}: ${message(error)}`); outcome.upload_failures.push(key); continue; }
      // Encryption uses a random nonce. Address the actual uploaded bytes so
      // identical plaintext files cannot overwrite one another's ciphertext.
      const object = `${ASSET_OBJECT_PREFIX}/${encrypted?.sha256 ?? file.sha256}`;
      try {
        await putFileAndVerifySize(storage, object, encrypted?.path ?? file.path, encrypted?.size ?? file.size,
          progress ? (done, total) => progress(`资产文件 ${key}`, done, total) : null, '资产文件', options.isCancelled, logger);
        next.entries.set(key, {
          sha256: file.sha256, size: file.size, updated_at: file.updated_at, object_key: object,
          base_sha256: entry?.sha256 ?? null, revision: entry ? increment(entry.revision) : 1n,
          device_id: options.deviceId, cipher_sha256: encrypted?.sha256 ?? null, cipher_size: encrypted?.size ?? null,
        });
        if (alias !== undefined && alias !== key) { next.entries.delete(alias); migrated.set(key, alias); }
        outcome.uploaded++;
      } catch (error) {
        if (isCloudRateLimited(message(error))) throw error;
        logger.warn(`[sync] 资产上传失败（跳过）: ${key}: ${message(error)}`); outcome.upload_failures.push(key);
      } finally { await encrypted?.dispose(); }
    }
  }
  if (direction !== 'Upload') {
    const slots = new Map<string, string>();
    for (const key of [...local.keys()].sort(compareFileText)) if (!slots.has(casefoldKey(key))) slots.set(casefoldKey(key), key);
    for (const canonical of [...canonicalToCloud.keys()].sort(compareFileText)) {
      const key = canonicalToCloud.get(canonical)!, entry = cloud.entries.get(key)!;
      const owner = [...legacyOwners].find(([, legacy]) => legacy === canonical)?.[0];
      const file = local.get(canonical) ?? (owner === undefined ? undefined : local.get(owner));
      if (file && ((file.sha256 === entry.sha256 && file.size === entry.size) || localFileWins(file.updated_at, entry.updated_at, file.sha256, entry.sha256))) continue;
      let dest;
      if (file) dest = file.path;
      else {
        const occupied = slots.get(casefoldKey(canonical));
        if (occupied !== undefined && occupied !== canonical) { outcome.download_failures.push(downloadCaseConflictMessage(key, occupied)); continue; }
        dest = assetLocalPath(active, app, canonical);
        if (dest === null) throw new SyncError(`Database error: 拒绝非法资产键，未推进文件同步: ${JSON.stringify(key)}`);
      }
      try { fs.mkdirSync(dirname(dest), { recursive: true }); }
      catch { // boundary-allow empty-catch: mod.rs:11962 ignores create_dir_all and leaves failure reporting to the download.
      }
      if (fs.existsSync(dest)) {
        try { saveConflictCopy(dest, options.deviceId); }
        catch (error) { logger.warn(`[sync] 保存资产冲突副本失败: ${key}: ${message(error)}`); }
      }
      const object = entry.object_key ?? `${ASSET_LEGACY_PREFIX}/${key}`; validateAssetObjectKey(object);
      try {
        await downloadFileObject(storage, object, dest, entry.sha256, entry.cipher_sha256, codec, options.isCancelled,
          progress ? (done, total) => progress(`资产文件 ${key}`, done, total) : null, `资产文件 ${key}`);
        outcome.downloaded++; slots.set(casefoldKey(canonical), canonical);
      } catch (error) {
        if (isCloudRateLimited(message(error))) throw error;
        logger.warn(`[sync] 资产下载失败（跳过）: ${key}: ${message(error)}`); outcome.download_failures.push(key);
      }
    }
    for (const [hidden, kept] of shadowed) {
      const a = cloud.entries.get(hidden)!, b = cloud.entries.get(kept)!;
      if (a.sha256 !== b.sha256 && localFileWins(a.updated_at, b.updated_at, a.sha256, b.sha256)) outcome.download_failures.push(shadowedDivergentMessage(hidden, kept));
    }
  }
  const same = next.entries.size === cloud.entries.size && [...next.entries].every(([key, entry]) => equal(entry, cloud.entries.get(key)));
  if (direction !== 'Download' && !same) {
    let merged;
    try { merged = await downloadAssetsManifest(storage, options); }
    catch (error) {
      if (isCloudRateLimited(message(error))) throw error;
      logger.warn(`[sync] 写前刷新资产清单失败，退回本地视图: ${message(error)}`); merged = clone(cloud);
    }
    const failedMigrations = new Set<string>();
    for (const [key, entry] of next.entries) {
      if (equal(entry, cloud.entries.get(key))) continue;
      const counterpart = merged.entries.has(key) ? key : migrated.get(key) ?? key;
      const theirs = merged.entries.get(counterpart);
      const matches = theirs ? entry.base_sha256 === theirs.sha256 && (theirs.revision === 0n || entry.revision === increment(theirs.revision)) : entry.base_sha256 == null;
      if (!matches) {
        const file = local.get(key); if (file) saveConflictCopy(file.path, options.deviceId);
        const alias = migrated.get(key); if (alias !== undefined) failedMigrations.add(alias);
        outcome.upload_failures.push(`${key}: 云端 base hash/revision 已变化，本地资产保留为冲突副本`); continue;
      }
      const newer = theirs && localFileWins(theirs.updated_at, entry.updated_at, theirs.sha256, entry.sha256);
      const upgrades = entry.cipher_sha256 !== null && theirs?.cipher_sha256 === null;
      if (!newer || upgrades) merged.entries.set(key, { ...entry });
      else { const alias = migrated.get(key); if (alias !== undefined) failedMigrations.add(alias); }
    }
    for (const key of cloud.entries.keys()) if (!next.entries.has(key) && !failedMigrations.has(key)) merged.entries.delete(key);
    merged.updated_at = toRfc3339(); await publishAssetManifest(storage, merged, options);
  }
  return outcome;
}

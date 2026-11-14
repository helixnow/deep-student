/** VFS content-addressed file transfers, sync/mod.rs:11196-11560,12367. */
import { fs } from '../src/local-runtime.ts';
import { basename, dirname, extname, isAbsolute, join, relative, sep } from '../../../platform/util/path.ts';
import { toRfc3339 } from '../../../platform/time/index.ts';
import { ioMessage } from '../../../platform/paths/io-error.ts';
import { isCloudRateLimited, SYNC_E2EE_PLAINTEXT_LEGACY_REJECTED_CODE, type CloudStorage } from '../../sync-providers/api.ts';
import { adaptTombstoneStorage } from '../../sync-support/api.ts';
import type { AsyncTombstoneReader } from './tombstone-needs.ts';
import { blobRelativePathProblem, parseBlobManifest } from './file-manifest.ts';
import type { BlobEntry, FileManifest } from './unsynced-classification.ts';
import { stringifyJsonLossless, type DbJson } from '../../../platform/util/lossless-json.ts';
import { SyncError } from './errors.ts';
import { putAndReread } from './manifest-upload.ts';
import { validateRemoteFormat, type ValidateRemoteFormatOptions } from './remote-format.ts';
import { timestampAfter, compareFileText } from './workspace-manifest.ts';
import { encryptUploadObject, downloadFileObject, putFileAndVerifySize, ensureFileUploadEncryptionPolicy } from './file-transfer.ts';
import type { FilePayloadCodec } from './payload.ts';
import type { FileSyncDirection, FileTransferProgress } from './workspace-sync.ts';
import type { SyncLogger } from './log.ts';
import { encodeUtf8 } from '../../../platform/util/portable.ts';

const sleep = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); });

export interface BlobSyncOptions extends ValidateRemoteFormatOptions {
  codec: FilePayloadCodec;
  tombstones: Pick<AsyncTombstoneReader, 'downloadBlobTombstones'>;
  logger: SyncLogger;
  isCancelled(): boolean;
}
export interface FileSyncOutcome { uploaded: number; downloaded: number; upload_failures: string[]; download_failures: string[] }
const PREFIX = 'data_governance/file_manifests/blobs';
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
export async function publishBlobManifest(storage: CloudStorage, manifest: FileManifest<BlobEntry>, options: ValidateRemoteFormatOptions): Promise<void> {
  await validateRemoteFormat(storage, true, options);
  let bytes;
  try {
    const entries: Record<string, DbJson> = Object.fromEntries([...manifest.entries].map(([key, entry]) => [key,
      Object.fromEntries(Object.entries(entry).filter(([, value]) => value != null)),
    ]));
    bytes = encodeUtf8(stringifyJsonLossless({ entries, updated_at: manifest.updated_at }));
  } catch (error) { throw new SyncError(`Database error: 序列化blob清单失败: ${message(error)}`); }
  await putAndReread(storage, `${PREFIX}/${globalThis.crypto.randomUUID()}.json`, await options.codec.encode(bytes), '文件级blob清单');
}
export async function downloadBlobsManifest(storage: CloudStorage, options: BlobSyncOptions): Promise<FileManifest<BlobEntry>> {
  const manifests: FileManifest<BlobEntry>[] = [];
  let bytes;
  try { bytes = await storage.get('data_governance/blobs_manifest.json'); }
  catch (error) { throw new SyncError(`Network error: 获取旧 blob 清单失败: ${message(error)}`); }
  if (bytes !== null) {
    const decoded = await options.codec.decode(bytes);
    try { manifests.push(parseBlobManifest(decoded)); }
    catch (error) { throw new SyncError(`Database error: 解析旧 blob 清单失败: ${message(error)}`); }
  }
  let list;
  try { list = await storage.listOutcome(PREFIX); }
  catch (error) { throw new SyncError(`Network error: 列举 blob 清单失败: ${message(error)}`); }
  if (list.truncated) throw new SyncError('Network error: blob 清单列表被截断，无法安全合并');
  for (const file of list.files) {
    if (!file.key.endsWith('.json')) continue;
    try { bytes = await storage.get(file.key); }
    catch (error) { throw new SyncError(`Network error: 读取 blob 清单 ${file.key} 失败: ${message(error)}`); }
    if (bytes === null) throw new SyncError(`Network error: 已列举的 blob 清单消失: ${file.key}`);
    const decoded = await options.codec.decode(bytes);
    try { manifests.push(parseBlobManifest(decoded)); }
    catch (error) { throw new SyncError(`Database error: 解析 blob 清单 ${file.key} 失败: ${message(error)}`); }
  }
  const merged: FileManifest<BlobEntry> = { entries: new Map(), updated_at: '' };
  for (const manifest of manifests) {
    if (compareFileText(manifest.updated_at, merged.updated_at) > 0) merged.updated_at = manifest.updated_at;
    for (const [hash, entry] of manifest.entries) {
      const current = merged.entries.get(hash);
      const replace = current === undefined || (current.cipher_sha256 === null && entry.cipher_sha256 !== null) ||
        ((current.cipher_sha256 === null) === (entry.cipher_sha256 === null) && timestampAfter(entry.updated_at, current.updated_at));
      if (replace) merged.entries.set(hash, entry);
    }
  }
  const deleted = await options.tombstones.downloadBlobTombstones(adaptTombstoneStorage(storage), options.codec);
  for (const [hash, tombstone] of Object.entries(deleted.entries)) {
    const entry = merged.entries.get(hash);
    if (entry && !timestampAfter(entry.updated_at, tombstone.deleted_at)) merged.entries.delete(hash);
  }
  return merged;
}
function scanBlobs(dir: string, result: Map<string, string>): void {
  let entries;
  try { entries = fs.readdirSync(dir); }
  catch (error) { throw new SyncError(`Database error: 读取 blobs 目录失败: ${ioMessage(error)}`); }
  for (const entry of entries) {
    const path = join(dir, entry);
    let meta;
    try { meta = fs.statSync(path); } catch { continue; }
    if (meta.isDirectory()) scanBlobs(path, result);
    else if (meta.isFile() && extname(path) !== '.tmp') result.set(basename(path, extname(path)), path);
  }
}
function size(path: string): bigint {
  try { return fs.statBigSync(path).size; } catch { return 0n; }
}
function mtime(path: string): string {
  try { return toRfc3339(fs.statBigSync(path).mtimeNs); } catch { return toRfc3339(); }
}
function discard(path: string): void {
  try { fs.rmSync(path, { force: true }); }
  catch { // boundary-allow empty-catch: mod.rs:11375,11400 ignore failed target removal before retry.
  }
}
/** Local target for a cloud blob entry, or the reason it is refused; nothing on disk is created here. */
// RUST-FIX(RF-W32-blob-relative-path-traversal): Rust mkdirs and downloads to blobs_dir.join(relative_path) without a containment or symlink check.
function downloadTarget(root: string, hash: string, relativePath: string): { dest: string } | { problem: string } {
  const problem = blobRelativePathProblem(hash, relativePath);
  if (problem !== null) return { problem };
  const dest = join(root, relativePath), inside = relative(root, dest);
  if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return { problem: '目标路径越出 blobs 目录' };
  let current = root;
  for (const part of relativePath.split('/')) {
    current = join(current, part);
    let meta;
    try { meta = fs.lstatSync(current); } catch { break; }
    if (meta.isSymbolicLink()) return { problem: `目标路径经过符号链接 ${current}` };
  }
  return { dest };
}

export async function syncVfsBlobs(
  storage: CloudStorage, root: string, direction: FileSyncDirection, options: BlobSyncOptions,
  progress?: FileTransferProgress | null, excluded: ReadonlySet<string> = new Set(), resurrection: ReadonlyMap<string, string> = new Map(),
): Promise<FileSyncOutcome> {
  const outcome: FileSyncOutcome = { uploaded: 0, downloaded: 0, upload_failures: [], download_failures: [] };
  if (!fs.existsSync(root)) return outcome;
  const cloud = await downloadBlobsManifest(storage, options);
  for (const hash of excluded) cloud.entries.delete(hash);
  const local = new Map<string, string>(); scanBlobs(root, local);
  const next: FileManifest<BlobEntry> = { updated_at: cloud.updated_at, entries: new Map(cloud.entries) };
  const { codec, logger } = options;
  if (direction !== 'Download') {
    await ensureFileUploadEncryptionPolicy(storage, codec.encrypted);
    for (const [hash, path] of local) {
      const entry = cloud.entries.get(hash);
      if (entry && !(codec.encrypted && entry.cipher_sha256 === null)) continue;
      const rel = relative(root, path).replaceAll('\\', '/'), key = `data_governance/blobs/${rel}`;
      const plainSize = size(path), updated = resurrection.get(hash) ?? mtime(path);
      let encrypted;
      try { encrypted = await encryptUploadObject(path, codec); }
      catch (error) { logger.error(`[sync] blob 加密失败: ${hash}: ${message(error)}`); outcome.upload_failures.push(hash); continue; }
      let last = '', ok = false;
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            await putFileAndVerifySize(storage, key, encrypted?.path ?? path, encrypted?.size ?? plainSize,
              progress ? (done, total) => progress(`VFS blob ${hash}`, done, total) : null, 'VFS blob', options.isCancelled, logger);
            next.entries.set(hash, { relative_path: rel, size: plainSize, updated_at: updated, cipher_sha256: encrypted?.sha256 ?? null, cipher_size: encrypted?.size ?? null });
            outcome.uploaded++; ok = true; break;
          } catch (error) {
            last = message(error); if (isCloudRateLimited(last)) throw error;
            if (attempt < 2) { logger.warn(`[sync] blob 上传重试 ${attempt + 1}/3: ${hash}: ${last}`); await sleep(500 * 2 ** attempt); }
          }
        }
        if (!ok) { logger.error(`[sync] blob 上传最终失败: ${hash}: ${last}`); outcome.upload_failures.push(hash); }
      } finally { await encrypted?.dispose(); }
    }
  }
  if (direction !== 'Upload') {
    for (const [hash, entry] of cloud.entries) {
      if (local.has(hash)) continue;
      const target = downloadTarget(root, hash, entry.relative_path);
      if ('problem' in target) {
        logger.error(`[sync] 拒绝下载 blob（清单路径不安全）: ${hash}: ${JSON.stringify(entry.relative_path)}: ${target.problem}`);
        outcome.download_failures.push(hash); continue;
      }
      const { dest } = target, key = `data_governance/blobs/${entry.relative_path}`;
      try { fs.mkdirSync(dirname(dest), { recursive: true }); }
      catch { // boundary-allow empty-catch: mod.rs:11330 ignores directory creation; transfer reports write error.
      }
      if (codec.encrypted && entry.cipher_sha256 === null) {
        logger.error(`[sync] [${SYNC_E2EE_PLAINTEXT_LEGACY_REJECTED_CODE}] blob 下载被拒绝（明文遗留对象，本端已启用端到端加密）: ${hash}。请在仍持有该附件的设备上配置同一加密密码并执行一次上传同步，该对象会被自动重新加密上传。`);
        outcome.download_failures.push(hash); continue;
      }
      let last = '', ok = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await downloadFileObject(storage, key, dest, hash, entry.cipher_sha256, codec, options.isCancelled,
            progress ? (done, total) => progress(`VFS blob ${hash}`, done, total) : null, `VFS blob ${hash}`);
        } catch (error) {
          last = message(error); if (isCloudRateLimited(last)) throw error;
          discard(dest);
          if (attempt < 2) { logger.warn(`[sync] blob 下载重试 ${attempt + 1}/3: ${hash}: ${last}`); await sleep(500 * 2 ** attempt); }
          continue;
        }
        const actual = size(dest);
        if (entry.size > 0n && actual !== entry.size) {
          last = `blob 大小不匹配: 期望 ${entry.size} 字节, 实际 ${actual} 字节`; discard(dest);
          if (attempt < 2) { logger.warn(`[sync] blob 大小校验失败，重试 ${attempt + 1}/3: ${hash}: ${last}`); await sleep(500 * 2 ** attempt); }
          continue;
        }
        outcome.downloaded++; ok = true; break;
      }
      if (!ok) { logger.error(`[sync] blob 下载最终失败: ${hash}: ${last}`); outcome.download_failures.push(hash); }
    }
  }
  if (outcome.uploaded > 0 || outcome.downloaded > 0) logger.info(`[sync] blob 同步: 上传 ${outcome.uploaded}, 下载 ${outcome.downloaded}, 上传失败 ${outcome.upload_failures.length}, 下载失败 ${outcome.download_failures.length}`);
  if (outcome.uploaded > 0) {
    let merged;
    try { merged = await downloadBlobsManifest(storage, options); }
    catch (error) {
      if (isCloudRateLimited(message(error))) throw error;
      logger.warn(`[sync] 写前刷新 blob 清单失败，退回本地视图: ${message(error)}`); merged = { entries: new Map(cloud.entries), updated_at: cloud.updated_at };
    }
    for (const [hash, entry] of next.entries) {
      const current = merged.entries.get(hash);
      if (!current || (current.cipher_sha256 === null && entry.cipher_sha256 !== null)) merged.entries.set(hash, { ...entry });
    }
    merged.updated_at = toRfc3339(); await publishBlobManifest(storage, merged, options);
  }
  return outcome;
}

/**
 * Cloud repository check (repo_check.rs, restic `check`-style, read-only).
 *
 * Walks every backup object referenced by the cloud manifests and verifies:
 * existence, SHA256 against the manifest, DSBK header decodability, and orphan
 * objects / manifest temp leftovers. Any truncated listing or object read
 * failure downgrades the verdict to `incomplete`; it never reports all-green on
 * partial information. The check never writes, overwrites or deletes anything.
 */

import { sha256Hasher } from './hashing.ts';
import { join } from '../../../platform/util/path.ts';
import { defaultLogSink } from './logging.ts';
import {
  DSBK_GCM_TAG_LEN,
  DSBK_MAX_PLAINTEXT_CHUNK,
  DSBK_V1_HEADER_LEN,
  DSBK_V2_CHUNK_OFFSET,
  DSBK_V2_HEADER_LEN,
  isEncryptedBackup,
} from '../../../platform/secrets/dsbk-stream.ts';
import type { CloudStorage } from '../api.ts';
import { CloudStorageError } from './errors.ts';
import { fs } from './local-fs.ts';
import { decodeEncryptionMarker } from './marker.ts';
import { SerdeJsonError } from './serde_struct.ts';
import { getFileWithOptionalResume } from './resume.ts';
import { chronoAutoSiZ } from './time.ts';
import { decodeManifest, type CloudManifest } from './manifest.ts';

/** Backup object directory (stable storage layout, deliberately duplicated). */
const BACKUPS_PREFIX = 'backups/';
/** Per-device manifest directory. */
const MANIFESTS_PREFIX = 'manifests/';
/** Legacy single-file manifest and its backup (read compatibility). */
const LEGACY_MANIFEST_KEYS = ['manifest.json', 'manifest.json.bak'] as const;
/** Cloud encryption marker object. */
const ENCRYPTION_MARKER_KEY = '.encryption-marker';

const DSBK_V1_MIN_OBJECT_LEN = DSBK_V1_HEADER_LEN + DSBK_GCM_TAG_LEN;
const DSBK_V2_MIN_OBJECT_LEN = DSBK_V2_HEADER_LEN + DSBK_GCM_TAG_LEN;
const HEAD_PROBE_LEN = 64;
const MAX_REPORTED_PROBLEMS = 500;

export type RepoCheckProblemKind =
  | 'missingObject'
  | 'checksumMismatch'
  | 'undecodableDsbkHeader'
  | 'plaintextInEncryptedRepo'
  | 'encryptedWithoutMarker'
  | 'orphanObject'
  | 'tempLeftover'
  | 'corruptManifest'
  | 'conflictingManifestEntry'
  | 'corruptEncryptionMarker'
  | 'objectReadFailed';

export type RepoCheckStatus = 'ok' | 'problemsFound' | 'incomplete';

export interface RepoCheckProblem {
  kind: RepoCheckProblemKind;
  objectKey?: string;
  versionId?: string;
  detail: string;
}

export interface RepoCheckReport {
  status: RepoCheckStatus;
  listingTruncated: boolean;
  encryptionMarkerPresent: boolean;
  versionsReferenced: number;
  objectsChecked: number;
  bytesVerified: number;
  orphanObjects: number;
  problems: RepoCheckProblem[];
  problemsTruncated: boolean;
  checkedAt: string;
}

interface ExpectedVersion {
  checksums: Set<string>;
}

interface CheckContext {
  problems: RepoCheckProblem[];
  listingTruncated: boolean;
  readFailed: boolean;
  orphanObjects: number;
  objectsChecked: number;
  bytesVerified: number;
}

function newContext(): CheckContext {
  return {
    problems: [],
    listingTruncated: false,
    readFailed: false,
    orphanObjects: 0,
    objectsChecked: 0,
    bytesVerified: 0,
  };
}

function pushProblem(
  ctx: CheckContext,
  kind: RepoCheckProblemKind,
  objectKey: string | null,
  versionId: string | null,
  detail: string,
): void {
  if (kind === 'objectReadFailed') ctx.readFailed = true;
  const problem: RepoCheckProblem = { kind, detail };
  if (objectKey !== null) problem.objectKey = objectKey;
  if (versionId !== null) problem.versionId = versionId;
  ctx.problems.push(problem);
}

/** Same rule as `sync_manager::validate_version_id`. */
export function versionIdIsValid(id: string): boolean {
  return id.length > 0
    && id.length <= 128
    && /^[A-Za-z0-9_-]+$/.test(id);
}

function checksumIsValid(checksum: string): boolean {
  return checksum.length === 64 && /^[0-9a-fA-F]+$/.test(checksum);
}

function shortHash(checksum: string): string {
  return checksum.slice(0, Math.min(16, checksum.length));
}

/**
 * Parses a DSBK header without decrypting. Returns `null` when decodable and a
 * reason string otherwise. `head` is the object prefix (magic already present)
 * and `objectLen` is the total object size.
 */
export function dsbkHeaderError(head: Uint8Array, objectLen: number): string | null {
  if (head.byteLength < 5) return '对象太短，读不到 DSBK 版本字节';
  const version = head[4]!;
  const parseParams = (): [number, number, number] | null => {
    if (head.byteLength < 17) return null;
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    return [view.getUint32(5, true), view.getUint32(9, true), view.getUint32(13, true)];
  };
  if (version === 1) {
    if (objectLen < DSBK_V1_MIN_OBJECT_LEN) {
      return `DSBK v1 对象被截断：${objectLen} 字节 < 最小 ${DSBK_V1_MIN_OBJECT_LEN} 字节`;
    }
    const params = parseParams();
    if (params === null) return 'DSBK v1 头被截断，读不到 Argon2 参数';
    const [m, t, p] = params;
    if (m === 0 || t === 0 || p === 0) return `DSBK v1 头 Argon2 参数非法: m=${m}, t=${t}, p=${p}`;
    return null;
  }
  if (version === 2) {
    if (objectLen < DSBK_V2_MIN_OBJECT_LEN) {
      return `DSBK v2 对象被截断：${objectLen} 字节 < 最小 ${DSBK_V2_MIN_OBJECT_LEN} 字节`;
    }
    if (head.byteLength < DSBK_V2_HEADER_LEN) return 'DSBK v2 头被截断，读不到分块参数';
    const params = parseParams();
    if (params === null) return 'DSBK v2 头被截断，读不到 Argon2 参数';
    const [m, t, p] = params;
    if (m === 0 || t === 0 || p === 0) return `DSBK v2 头 Argon2 参数非法: m=${m}, t=${t}, p=${p}`;
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    const chunk = view.getUint32(DSBK_V2_CHUNK_OFFSET, true);
    if (chunk === 0 || chunk > DSBK_MAX_PLAINTEXT_CHUNK) return `DSBK v2 头分块大小非法: ${chunk}`;
    return null;
  }
  return `未知 DSBK 版本: ${version}`;
}

async function readHeadProbe(path: string): Promise<Uint8Array> {
  const handle = await fs.open(path, 'r');
  try {
    const buffer = new Uint8Array(HEAD_PROBE_LEN);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_PROBE_LEN, null);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function hashFileSha256(path: string): Promise<string> {
  const hasher = sha256Hasher();
  for await (const chunk of fs.readChunks(path, 1024 * 1024)) {
    hasher.update(chunk);
  }
  return hasher.digestHex();
}

async function downloadObjectForCheck(storage: CloudStorage, key: string, dest: string): Promise<void> {
  await getFileWithOptionalResume(storage, key, dest, null, null);
}

/** repo_check.rs:394 `serde_json::from_slice::<EncryptionMarker>(..).is_err()`. */
function markerIsParseable(data: Uint8Array): boolean {
  try {
    decodeEncryptionMarker(data);
    return true;
  } catch (error) {
    if (error instanceof SerdeJsonError) return false;
    throw error;
  }
}

async function collectManifest(
  storage: CloudStorage,
  key: string,
  expected: Map<string, ExpectedVersion>,
  ctx: CheckContext,
): Promise<void> {
  let data: Uint8Array | null;
  try {
    data = await storage.get(key);
  } catch (error) {
    pushProblem(ctx, 'objectReadFailed', key, null,
      `读取 manifest 失败: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (data === null) return;
  let manifest: CloudManifest;
  try {
    manifest = decodeManifest(key, data);
  } catch (error) {
    pushProblem(ctx, 'corruptManifest', key, null,
      `manifest 无法解析: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  for (const version of manifest.versions) {
    if (!versionIdIsValid(version.id)) {
      pushProblem(ctx, 'corruptManifest', key, null, `manifest 含非法版本 ID: ${JSON.stringify(version.id)}`);
      continue;
    }
    let entry = expected.get(version.id);
    if (entry === undefined) {
      entry = { checksums: new Set() };
      expected.set(version.id, entry);
    }
    if (checksumIsValid(version.checksum)) {
      entry.checksums.add(version.checksum);
    } else {
      pushProblem(ctx, 'corruptManifest', key, version.id,
        `版本 ${version.id} 登记的校验和非法: ${JSON.stringify(version.checksum)}`);
    }
  }
}

/**
 * Runs one read-only cloud repository check.
 *
 * Top-level failures (connection/list/temp dir) reject; object-level problems
 * are collected in the report so the remaining objects are still checked.
 */
export async function runRepoCheck(storage: CloudStorage): Promise<RepoCheckReport> {
  await storage.checkConnection();

  const ctx = newContext();

  // 1. Encryption marker decides the expected DSBK shape.
  const markerRaw = await storage.get(ENCRYPTION_MARKER_KEY);
  const encryptionMarkerPresent = markerRaw !== null;
  if (markerRaw !== null && !markerIsParseable(markerRaw)) {
    pushProblem(ctx, 'corruptEncryptionMarker', ENCRYPTION_MARKER_KEY, null,
      '加密标记对象存在但内容无法解析（fail-closed，按加密仓库巡检）');
  }

  // 2. Aggregate every manifest reference.
  const manifestsList = await storage.listOutcome(MANIFESTS_PREFIX);
  const manifestsTruncated = manifestsList.truncated;
  if (manifestsTruncated) ctx.listingTruncated = true;

  const expected = new Map<string, ExpectedVersion>();
  for (const file of manifestsList.files) {
    if (file.key.endsWith('.json')) {
      await collectManifest(storage, file.key, expected, ctx);
    } else {
      pushProblem(ctx, 'tempLeftover', file.key, null,
        `manifests/ 下的非 manifest 残留对象（${file.size} 字节）`);
    }
  }
  for (const key of LEGACY_MANIFEST_KEYS) {
    await collectManifest(storage, key, expected, ctx);
  }

  for (const [id, version] of expected) {
    if (version.checksums.size > 1) {
      pushProblem(ctx, 'conflictingManifestEntry', `${BACKUPS_PREFIX}${id}.zip`, id,
        `版本 ${id} 在不同 manifest 中登记了 ${version.checksums.size} 个互相矛盾的校验和`);
    }
  }

  // 3. Orphan detection (skipped when the manifest listing itself is truncated).
  const backupsList = await storage.listOutcome(BACKUPS_PREFIX);
  if (backupsList.truncated) ctx.listingTruncated = true;
  const referencedKeys = new Set([...expected.keys()].map(id => `${BACKUPS_PREFIX}${id}.zip`));
  if (manifestsTruncated) {
    defaultLogSink().warn('[RepoCheck] manifests 列表被截断，本轮跳过孤儿对象判定');
  } else {
    for (const file of backupsList.files) {
      if (!referencedKeys.has(file.key)) {
        ctx.orphanObjects += 1;
        pushProblem(ctx, 'orphanObject', file.key, null,
          `未被任何 manifest 引用（${file.size} 字节），仅占用空间`);
      }
    }
  }

  // 4. Verify every referenced object: existence / SHA256 / DSBK header.
  const tempDir = await fs.mkdtemp(join(fs.tmpDir(), 'repo-check-')).catch(error => {
    throw new CloudStorageError('FileSystem',
      `创建巡检临时目录失败: ${error instanceof Error ? error.message : String(error)}`);
  });

  try {
    for (const [id, version] of expected) {
      const key = `${BACKUPS_PREFIX}${id}.zip`;

      let info;
      try {
        info = await storage.stat(key);
      } catch (error) {
        pushProblem(ctx, 'objectReadFailed', key, id,
          `查询对象元信息失败: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (info === null) {
        pushProblem(ctx, 'missingObject', key, id,
          'manifest 引用的备份对象在云端不存在，该版本已无法恢复');
        continue;
      }

      const localPath = join(tempDir, 'repo-check-object.partial');
      await fs.rm(localPath, { force: true });
      try {
        await downloadObjectForCheck(storage, key, localPath);
      } catch (error) {
        pushProblem(ctx, 'objectReadFailed', key, id,
          `下载对象做校验失败: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }

      let objectLen: number;
      try {
        objectLen = (await fs.stat(localPath)).size;
      } catch (error) {
        pushProblem(ctx, 'objectReadFailed', key, id,
          `读取已下载对象元信息失败: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }

      let actualChecksum: string;
      try {
        actualChecksum = await hashFileSha256(localPath);
      } catch (error) {
        pushProblem(ctx, 'objectReadFailed', key, id,
          `计算对象 SHA256 失败: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      ctx.objectsChecked += 1;
      ctx.bytesVerified += objectLen;
      if (version.checksums.size > 0 && !version.checksums.has(actualChecksum)) {
        const expectedShort = [...version.checksums].map(shortHash).join(' / ');
        pushProblem(ctx, 'checksumMismatch', key, id,
          `SHA256 不匹配：manifest 登记 ${expectedShort}…，实际 ${shortHash(actualChecksum)}…；对象已损坏或被改动`);
      }

      let head: Uint8Array;
      try {
        head = await readHeadProbe(localPath);
      } catch (error) {
        pushProblem(ctx, 'objectReadFailed', key, id,
          `读取对象头部失败: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      const hasDsbkMagic = isEncryptedBackup(head);
      if (encryptionMarkerPresent) {
        if (!hasDsbkMagic) {
          pushProblem(ctx, 'plaintextInEncryptedRepo', key, id,
            '加密仓库中发现无 DSBK 头的对象（明文或已损坏），配置了加密密码的设备将无法解密恢复它');
        } else {
          const reason = dsbkHeaderError(head, objectLen);
          if (reason !== null) {
            pushProblem(ctx, 'undecodableDsbkHeader', key, id, `DSBK 加密头不可解：${reason}`);
          }
        }
      } else if (hasDsbkMagic) {
        pushProblem(ctx, 'encryptedWithoutMarker', key, id,
          '对象是 DSBK 密文但云端没有加密标记（标记疑似被删），明文上传拦截已失效');
        const reason = dsbkHeaderError(head, objectLen);
        if (reason !== null) {
          pushProblem(ctx, 'undecodableDsbkHeader', key, id, `DSBK 加密头不可解：${reason}`);
        }
      }

      await fs.rm(localPath, { force: true });
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }

  // 5. Any incompleteness refuses an all-green verdict.
  const hasRealProblems = ctx.problems.some(problem => problem.kind !== 'objectReadFailed');
  const incomplete = ctx.listingTruncated || ctx.readFailed;
  const status: RepoCheckStatus = hasRealProblems ? 'problemsFound' : incomplete ? 'incomplete' : 'ok';

  const problemsTruncated = ctx.problems.length > MAX_REPORTED_PROBLEMS;
  const problems = ctx.problems.slice(0, MAX_REPORTED_PROBLEMS);

  return {
    status,
    listingTruncated: ctx.listingTruncated,
    encryptionMarkerPresent,
    versionsReferenced: expected.size,
    objectsChecked: ctx.objectsChecked,
    bytesVerified: ctx.bytesVerified,
    orphanObjects: ctx.orphanObjects,
    problems,
    problemsTruncated,
    checkedAt: chronoAutoSiZ(Date.now()),
  };
}

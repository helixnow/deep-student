/**
 * [R4-verified-publish] Verified cloud object publication (verified_publish.rs).
 *
 * `put` returning Ok does not mean the remote bytes are right. Publication is split
 * into four checkable steps and any mismatch fails closed:
 *   1. PUT to `<key>.tmp-<op>`;
 *   2. bounded read-back (stat, then bounded get) and byte comparison;
 *   3. PUT the final key;
 *   4. bounded read-back of the final key.
 */

import type { CloudStorage } from '../api.ts';
import { CloudStorageError } from './errors.ts';
import { defaultLogSink } from './logging.ts';
import { randomHex } from './random.ts';
import { bytesEqual } from './bytes.ts';

export const VERIFIED_PUBLISH_UNCONDITIONAL_WRITE_CODE = 'E_VERIFIED_PUBLISH_UNCONDITIONAL_WRITE';
export const VERIFIED_PUBLISH_MISMATCH_CODE = 'E_VERIFIED_PUBLISH_MISMATCH';
export const VERIFIED_PUBLISH_OVERSIZE_CODE = 'E_VERIFIED_PUBLISH_OVERSIZE';

export type PublishRecovery = 'KeepTmp' | 'IsolateBad';

export interface PublishSpec {
  key: string;
  maxBytes: number;
  expectedGeneration?: string | null;
  recovery: PublishRecovery;
}

export function unconditionalSpec(key: string, maxBytes: number, recovery: PublishRecovery): PublishSpec {
  return { key, maxBytes, expectedGeneration: null, recovery };
}

function publishError(code: string, message: string): CloudStorageError {
  return new CloudStorageError('Unknown', `[${code}] ${message}`);
}

function validateSpec(spec: PublishSpec, dataLen: number): void {
  const key = spec.key.trim();
  if (!key) throw new CloudStorageError('Validation', '验证式发布：对象键不能为空');
  if (key.startsWith('/') || key.includes('..') || key.includes('\\')) {
    throw new CloudStorageError('Validation', `验证式发布：对象键含非法路径成分，已拒绝：${key}`);
  }
  if (spec.maxBytes === 0) {
    throw new CloudStorageError('Validation', '验证式发布：max_bytes 必须大于零（有界回读上限）');
  }
  if (dataLen > spec.maxBytes) {
    throw publishError(VERIFIED_PUBLISH_OVERSIZE_CODE,
      `待发布数据 ${dataLen} 字节超过 max_bytes=${spec.maxBytes} 上限，已在任何写入前拒绝`);
  }
}

async function readBackAndCompare(
  storage: CloudStorage,
  key: string,
  expected: Uint8Array,
  maxBytes: number,
  stage: string,
): Promise<void> {
  const info = await storage.stat(key);
  if (info === null) {
    throw publishError(VERIFIED_PUBLISH_MISMATCH_CODE, `${stage}回读：PUT 成功后对象不存在：${key}`);
  }
  if (info.size > maxBytes) {
    throw publishError(VERIFIED_PUBLISH_OVERSIZE_CODE,
      `${stage}回读：远端对象 ${key} 为 ${info.size} 字节，超过 max_bytes=${maxBytes} 上限，拒绝下载核对`);
  }
  if (info.size !== expected.byteLength) {
    throw publishError(VERIFIED_PUBLISH_MISMATCH_CODE,
      `${stage}回读：远端对象 ${key} 声明 ${info.size} 字节，本地为 ${expected.byteLength} 字节`);
  }
  const bytes = await storage.getBounded(key, maxBytes);
  if (bytes === null) {
    throw publishError(VERIFIED_PUBLISH_MISMATCH_CODE, `${stage}回读：stat 可见但 get 不到对象：${key}`);
  }
  if (bytes.byteLength > maxBytes) {
    throw publishError(VERIFIED_PUBLISH_OVERSIZE_CODE,
      `${stage}回读：远端对象 ${key} 实收 ${bytes.byteLength} 字节超过 max_bytes=${maxBytes} 上限`);
  }
  if (!bytesEqual(bytes, expected)) {
    throw publishError(VERIFIED_PUBLISH_MISMATCH_CODE,
      `${stage}回读：远端对象 ${key} 字节内容与本地不一致（${bytes.byteLength} vs ${expected.byteLength} 字节，或同长不同内容）`);
  }
}

/** `<key>.bad-<UTC timestamp>-<8 hex>`, so concurrent isolations never collide. */
export function badKeyFor(key: string): string {
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace('.', '');
  return `${key}.bad-${ts}-${randomHex(4)}`;
}

async function isolateBadObject(storage: CloudStorage, fromKey: string, maxBytes: number): Promise<string> {
  const info = await storage.stat(fromKey).catch(error => {
    throw new Error(`stat 坏对象 ${fromKey} 失败：${String(error)}，原件保留在原位`);
  });
  if (info === null) throw new Error(`坏对象 ${fromKey} 已不存在，无需隔离`);
  if (info.size > maxBytes) {
    throw new Error(`坏对象 ${fromKey} 为 ${info.size} 字节，超过 max_bytes=${maxBytes}，拒绝下载复制，原件保留在原位`);
  }
  const bytes = await storage.getBounded(fromKey, maxBytes).catch(error => {
    throw new Error(`读取坏对象 ${fromKey} 失败：${String(error)}，原件保留在原位`);
  });
  if (bytes === null) throw new Error(`坏对象 ${fromKey} 在隔离期间消失，未做处理`);
  const badKey = badKeyFor(fromKey);
  try { await storage.put(badKey, bytes); }
  catch (error) { throw new Error(`写隔离副本 ${badKey} 失败：${String(error)}，原件 ${fromKey} 保留在原位`); }
  const copy = await storage.stat(badKey).catch(() => null);
  if (copy === null || copy.size !== bytes.byteLength) {
    throw new Error(`隔离副本 ${badKey} 核对失败，原件 ${fromKey} 与副本均保留`);
  }
  try { await storage.delete(fromKey); }
  catch (error) { throw new Error(`删除原坏对象 ${fromKey} 失败：${String(error)}（隔离副本 ${badKey} 已就位）`); }
  return badKey;
}

async function applyRecovery(
  storage: CloudStorage,
  recovery: PublishRecovery,
  badObjectKey: string,
  tmpKey: string,
  maxBytes: number,
): Promise<string> {
  const tmpNote = badObjectKey === tmpKey ? '' : `；暂存对象 ${tmpKey} 保留供恢复（其内容已验证）`;
  if (recovery === 'KeepTmp') return `已按 KeepTmp 保留可疑对象 ${badObjectKey} 供诊断${tmpNote}`;
  try {
    const badKey = await isolateBadObject(storage, badObjectKey, maxBytes);
    return `已把坏对象 ${badObjectKey} 隔离为 ${badKey}${tmpNote}`;
  } catch (error) {
    return `隔离失败（fail-closed，原件未删）：${error instanceof Error ? error.message : String(error)}${tmpNote}`;
  }
}

/**
 * Verified publication. Succeeds only when the final key's remote bytes equal `data`.
 * `expectedGeneration` fails closed with the stable unconditional-write code, because
 * none of the transports implement conditional PUT.
 */
export async function verifiedPublish(storage: CloudStorage, spec: PublishSpec, data: Uint8Array): Promise<void> {
  validateSpec(spec, data.byteLength);
  const key = spec.key.trim();

  if (spec.expectedGeneration != null) {
    throw new CloudStorageError('Configuration',
      `[${VERIFIED_PUBLISH_UNCONDITIONAL_WRITE_CODE}] 后端 ${storage.providerName()} 只支持无条件写：`
      + `没有 conditional PUT / If-Match / generation，无法按期望版本 ${JSON.stringify(spec.expectedGeneration)} 条件发布 ${key}。`
      + '请上层先经租约（sync_lease / backup-v2 仓库租约）串行化，再以无条件规格重试；本原语拒绝假装完成 CAS');
  }

  const tmpKey = `${key}.tmp-${randomHex(6)}`;

  await storage.put(tmpKey, data);
  try {
    await readBackAndCompare(storage, tmpKey, data, spec.maxBytes, '暂存');
  } catch (error) {
    const disposition = await applyRecovery(storage, spec.recovery, tmpKey, tmpKey, spec.maxBytes);
    throw new CloudStorageError('Unknown',
      `${error instanceof Error ? error.message : String(error)}；最终键 ${key} 未被触碰。${disposition}`);
  }

  try { await storage.put(key, data); }
  catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CloudStorageError('Unknown', `${detail}；发布最终键 ${key} 失败，已保留验证过的暂存对象 ${tmpKey} 供恢复`);
  }
  try {
    await readBackAndCompare(storage, key, data, spec.maxBytes, '发布后');
  } catch (error) {
    const disposition = await applyRecovery(storage, spec.recovery, key, tmpKey, spec.maxBytes);
    throw new CloudStorageError('Unknown', `${error instanceof Error ? error.message : String(error)}。${disposition}`);
  }

  try { await storage.delete(tmpKey); }
  catch (error) {
    defaultLogSink().warn(
      `[VerifiedPublish] 发布成功但清理暂存对象失败（不影响结果）: ${tmpKey}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

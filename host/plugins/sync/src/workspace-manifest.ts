/** sync/mod.rs:10242-10255,11074-11154. */
import type { CloudStorage } from '../../sync-providers/api.ts';
import { adaptTombstoneStorage } from '../../sync-support/api.ts';
import { parseFlexibleTimestampSqlite } from '../../../platform/time/index.ts';
import { rustTrim } from '../../../platform/util/index.ts';
import type { AsyncWorkspaceTombstones } from './tombstone-needs.ts';
import { parseWorkspaceManifest, type WorkspaceEntry } from './file-manifest.ts';
import type { FileManifest } from './unsynced-classification.ts';
import { stringifyJsonLossless, type DbJson } from '../../../platform/util/lossless-json.ts';
import { SyncError } from './errors.ts';
import { validateRemoteFormat, type ValidateRemoteFormatOptions } from './remote-format.ts';
import { putAndReread } from './manifest-upload.ts';
import { compareUtf8, encodeUtf8 } from '../../../platform/util/portable.ts';

export const WORKSPACE_MANIFEST_PREFIX = 'data_governance/file_manifests/workspaces';
export const WORKSPACE_OBJECT_PREFIX = 'data_governance/workspaces';
export type WorkspaceManifest = FileManifest<WorkspaceEntry>;
export interface WorkspaceManifestOptions extends ValidateRemoteFormatOptions { tombstones: AsyncWorkspaceTombstones }
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
export const compareFileText = (a: string, b: string) => compareUtf8(a, b);
export function timestampAfter(candidate: string, reference: string): boolean {
  if (rustTrim(candidate) === '' || rustTrim(reference) === '') return false;
  const a = parseFlexibleTimestampSqlite(candidate), b = parseFlexibleTimestampSqlite(reference);
  return a !== null && b !== null ? a.epochNanos > b.epochNanos : compareFileText(candidate, reference) > 0;
}

export async function publishWorkspaceManifest(storage: CloudStorage, manifest: WorkspaceManifest, options: ValidateRemoteFormatOptions): Promise<void> {
  await validateRemoteFormat(storage, true, options);
  let json;
  try {
    const entries: Record<string, DbJson> = Object.fromEntries([...manifest.entries].map(([id, entry]) => [
      id, Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== null)),
    ]));
    json = encodeUtf8(stringifyJsonLossless({ entries, updated_at: manifest.updated_at }));
  } catch (error) { throw new SyncError(`Database error: 序列化工作区清单失败: ${message(error)}`); }
  const bytes = await options.codec.encode(json);
  await putAndReread(storage, `${WORKSPACE_MANIFEST_PREFIX}/${globalThis.crypto.randomUUID()}.json`, bytes, '文件级工作区清单');
}

export async function downloadWorkspacesManifest(storage: CloudStorage, options: WorkspaceManifestOptions): Promise<WorkspaceManifest> {
  const manifests: WorkspaceManifest[] = [];
  let legacy;
  try { legacy = await storage.get('data_governance/workspaces_manifest.json'); }
  catch (error) { throw new SyncError(`Network error: 获取旧工作区清单失败: ${message(error)}`); }
  if (legacy !== null) {
    const decoded = await options.codec.decode(legacy);
    try { manifests.push(parseWorkspaceManifest(decoded)); }
    catch (error) { throw new SyncError(`Database error: 解析旧工作区清单失败: ${message(error)}`); }
  }
  let list;
  try { list = await storage.listOutcome(WORKSPACE_MANIFEST_PREFIX); }
  catch (error) { throw new SyncError(`Network error: 列举工作区清单失败: ${message(error)}`); }
  if (list.truncated) throw new SyncError('Network error: 工作区清单列表被截断，无法安全合并');
  for (const file of list.files) {
    if (!file.key.endsWith('.json')) continue;
    let bytes;
    try { bytes = await storage.get(file.key); }
    catch (error) { throw new SyncError(`Network error: 读取工作区清单 ${file.key} 失败: ${message(error)}`); }
    if (bytes === null) throw new SyncError(`Network error: 已列举的工作区清单消失: ${file.key}`);
    const decoded = await options.codec.decode(bytes);
    try { manifests.push(parseWorkspaceManifest(decoded)); }
    catch (error) { throw new SyncError(`Database error: 解析工作区清单 ${file.key} 失败: ${message(error)}`); }
  }
  const merged: WorkspaceManifest = { entries: new Map(), updated_at: '' };
  for (const manifest of manifests) {
    if (compareFileText(manifest.updated_at, merged.updated_at) > 0) merged.updated_at = manifest.updated_at;
    for (const [id, entry] of manifest.entries) {
      const current = merged.entries.get(id);
      if (current === undefined || entry.revision > current.revision || (entry.revision === current.revision && compareFileText(entry.sha256, current.sha256) > 0)) merged.entries.set(id, entry);
    }
  }
  const tombstones = await options.tombstones.downloadWorkspaceTombstones(adaptTombstoneStorage(storage), options.codec);
  for (const [id, tombstone] of Object.entries(tombstones.entries)) {
    const entry = merged.entries.get(id);
    if (entry && !timestampAfter(entry.updated_at, tombstone.deleted_at)) merged.entries.delete(id);
  }
  return merged;
}

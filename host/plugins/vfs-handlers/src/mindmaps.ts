/** handlers.rs:5088-5351. Command inputs bound to L11's MindmapRepository. */
import type { Context } from '@deepseek-ai/cordis';
import { CommandError } from '../../../kernel/api.ts';
import type { CreateMindMapInput, UpdateMindMapInput } from '../../../../contracts/ipc/generated/L13-vfs-api.ts';
import type { VfsMindMap, VfsMindMapVersion } from '../../vfs-repos/api.ts';
import { validateFileSize } from './resources.ts';

export interface MindmapService {
  createMindmapInFolder(params: Required<Omit<CreateMindMapInput, 'folderId'>>, folderId: string | null): VfsMindMap;
  getMindmap(id: string): VfsMindMap | null;
  getMindmapContent(id: string): string | null;
  getVersionsPaged(id: string, limit: number): VfsMindMapVersion[];
  restoreVersion(id: string): VfsMindMap;
  getVersionContent(id: string): string | null;
  getVersion(id: string): VfsMindMapVersion | null;
  updateMindmap(id: string, params: UpdateMindMapInput & { versionSource: 'manual' | 'auto' }): VfsMindMap;
  deleteMindmap(id: string): void;
  listMindmaps(): VfsMindMap[];
  setFavorite(id: string, favorite: boolean): void;
}
export interface MindmapDeps { service?: MindmapService; log: Context['logger'] }
function service(deps: MindmapDeps): MindmapService {
  if (deps.service === undefined) throw new Error('L11 vfsMindmaps 服务未发布');
  return deps.service;
}
function command<T>(fn: () => T): T {
  try { return fn(); } catch (error) { throw new CommandError(error instanceof Error ? error.message : String(error)); }
}
function validate(id: string, version = false) {
  if (!id.startsWith(version ? 'mv_' : 'mm_')) {
    const kind = version ? 'version' : 'mindmap';
    throw new Error(`Invalid argument '${kind}_id': Invalid ${kind} ID format: ${id}`);
  }
}
export function create(deps: MindmapDeps, params: CreateMindMapInput) {
  deps.log.info('[VFS::handlers] vfs_create_mindmap: title=%s, folder_id=%s', params.title, params.folderId ?? null);
  return command(() => {
    const content = params.content ?? '{"version":"1.0","root":{"id":"root","text":"根节点","children":[]}}';
    validateFileSize('mindmap', content);
    return service(deps).createMindmapInFolder({ title: params.title, description: params.description ?? null,
      content, defaultView: params.defaultView ?? 'mindmap', theme: params.theme ?? null }, params.folderId ?? null);
  });
}
export function get(deps: MindmapDeps, id: string) {
  deps.log.debug('[VFS::handlers] vfs_get_mindmap: id=%s', id);
  return command(() => { validate(id); return service(deps).getMindmap(id); });
}
export function content(deps: MindmapDeps, id: string) {
  deps.log.debug('[VFS::handlers] vfs_get_mindmap_content: id=%s', id);
  return command(() => { validate(id); return service(deps).getMindmapContent(id); });
}
export function versions(deps: MindmapDeps, id: string, limit: number | null) {
  deps.log.debug('[VFS::handlers] vfs_get_mindmap_versions: id=%s, limit=%s', id, limit);
  return command(() => { validate(id); return service(deps).getVersionsPaged(id, Math.max(1, Math.min(500, limit ?? 100))); });
}
export function restore(deps: MindmapDeps, id: string) {
  deps.log.info('[VFS::handlers] vfs_restore_mindmap_version: id=%s', id);
  return command(() => { validate(id, true); return service(deps).restoreVersion(id); });
}
export function versionContent(deps: MindmapDeps, id: string) {
  deps.log.debug('[VFS::handlers] vfs_get_mindmap_version_content: id=%s', id);
  return command(() => { validate(id, true); return service(deps).getVersionContent(id); });
}
export function version(deps: MindmapDeps, id: string) {
  deps.log.debug('[VFS::handlers] vfs_get_mindmap_version: id=%s', id);
  return command(() => { validate(id, true); return service(deps).getVersion(id); });
}
export function update(deps: MindmapDeps, id: string, params: UpdateMindMapInput) {
  deps.log.info('[VFS::handlers] vfs_update_mindmap: id=%s', id);
  return command(() => {
    validate(id);
    if (params.content != null) validateFileSize('mindmap', params.content);
    const versionSource = params.versionSource === 'auto' ? 'auto' : 'manual';
    if (params.versionSource != null && !['manual', 'auto'].includes(params.versionSource)) {
      deps.log.warn("[VFS::handlers] vfs_update_mindmap: invalid versionSource %s for %s, falling back to 'manual'", params.versionSource, id);
    }
    return service(deps).updateMindmap(id, { ...params, versionSource });
  });
}
export function remove(deps: MindmapDeps, id: string) {
  deps.log.info('[VFS::handlers] vfs_delete_mindmap: id=%s', id);
  return command(() => { validate(id); service(deps).deleteMindmap(id); return null; });
}
export function list(deps: MindmapDeps) {
  deps.log.debug('[VFS::handlers] vfs_list_mindmaps');
  return command(() => service(deps).listMindmaps());
}
export function favorite(deps: MindmapDeps, id: string, value: boolean) {
  deps.log.info('[VFS::handlers] vfs_set_mindmap_favorite: id=%s, is_favorite=%s', id, value);
  return command(() => { validate(id); service(deps).setFavorite(id, value); return null; });
}
export type { CreateMindMapInput, UpdateMindMapInput };

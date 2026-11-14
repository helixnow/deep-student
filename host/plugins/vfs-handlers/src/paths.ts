/** handlers.rs:1044-1187: validation/error mapping; L11 owns path computation and writes. */
import type { Context } from '@deepseek-ai/cordis';
import { requireMaintenance, type VfsMaintenanceService } from './maintenance-needs.ts';
import { CommandError } from '../../../kernel/api.ts';
import { VfsError } from '../../vfs/portable.ts';

export interface PathDeps {
  readonly maintenance: VfsMaintenanceService;
  readonly log: Context['logger'];
}
function fail(error: unknown): never {
  if (error instanceof VfsError) throw new CommandError(error.toString());
  if (error instanceof Error) throw new CommandError(error.message);
  throw error;
}
export function getResourcePath(deps: PathDeps, sourceId: string): string {
  deps.log.info('[VFS::handlers] vfs_get_resource_path: source_id=%s', sourceId);
  try { return requireMaintenance(deps.maintenance).getResourcePath(sourceId); } catch (error) { return fail(error); }
}
export function updatePathCache(deps: PathDeps, folderId: string): number {
  deps.log.info('[VFS::handlers] vfs_update_path_cache: folder_id=%s', folderId);
  if (!folderId.startsWith('fld_')) return fail(new VfsError('InvalidArgument', {
    param: 'folder_id', reason: `Invalid folder ID format: ${folderId}`,
  }));
  try { return requireMaintenance(deps.maintenance).updatePathCache(folderId); } catch (error) { return fail(error); }
}

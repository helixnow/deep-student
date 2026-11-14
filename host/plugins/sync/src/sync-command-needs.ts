/** Command-level ports: L21 owns shared permits/SSOT/audit; sync owns database routing. */
import type { WorkspaceCoordinator } from '../../agent-workspace/api.ts';
import type { BackupSyncCommandPorts } from '../../backup/api.ts';
export type { SyncAuditRequest } from '../../backup/api.ts';
import type { FileLevelSyncOptions } from './file-level-sync.ts';
import type { SyncDatabaseApplication } from './record-progress.ts';
import type { SyncContext } from './dependencies.ts';

export interface SyncCommandPorts extends Pick<BackupSyncCommandPorts, 'loadHydratedCloudConfig' | 'saveSyncAudit'> {
  limiter: Pick<BackupSyncCommandPorts['limiter'], 'tryAcquire'>;
  tombstones: FileLevelSyncOptions['tombstones'];
  /** @deprecated The production command now uses ctx.sync.applyDownloadedChangesToDatabases. */
  application?: SyncDatabaseApplication;
  workspaceCoordinator: Pick<WorkspaceCoordinator, 'enterMaintenanceMode' | 'exitMaintenanceMode'> | null;
}

export type LocalSyncCommandPorts = Pick<SyncCommandPorts, 'tombstones' | 'workspaceCoordinator'>;
/** L21 owns permits/config/audit; no service cycle and no duplicate coordinator. */
export function assembleSyncCommandPorts(ctx: SyncContext, local: LocalSyncCommandPorts): SyncCommandPorts {
  const shared = ctx.backup.syncCommandPorts();
  return {
    limiter: shared.limiter,
    loadHydratedCloudConfig: () => shared.loadHydratedCloudConfig(),
    saveSyncAudit: request => shared.saveSyncAudit(request),
    tombstones: local.tombstones,
    workspaceCoordinator: local.workspaceCoordinator,
  };
}

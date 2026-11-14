/** L11's published table-owner maintenance contract. */
import type { VfsMaintenanceService } from '../../vfs-repos/api.ts';
export type { VfsMaintenanceService } from '../../vfs-repos/api.ts';

export function requireMaintenance(service: VfsMaintenanceService | undefined): VfsMaintenanceService {
  if (service === undefined) throw new Error('待接线：vfsMaintenance（L11 表所有者的写操作接口）');
  return service;
}

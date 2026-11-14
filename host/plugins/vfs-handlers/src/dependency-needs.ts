/** New names mandated by ARCHITECTURE.md; remove duplicate declarations once providers publish them.
 * The interfaces are imported from the owning api.ts, never reimplemented here.
 */
import type { VfsReposService, VfsMaintenanceService } from '../../vfs-repos/api.ts';
import type { NotesService } from '../../notes/api.ts';
import type { QbankService } from '../../qbank/api.ts';
import type { UnitBuilderService } from './index-admin.ts';
declare module '@deepseek-ai/cordis' {
  interface Context {
    vfsRepo: VfsReposService;
    notes: NotesService;
    qbank: QbankService;
    vfsUnitBuilder: UnitBuilderService;
    vfsMaintenance: VfsMaintenanceService;
  }
}

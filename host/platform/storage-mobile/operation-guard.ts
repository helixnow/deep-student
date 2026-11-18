import type { DataGovernanceOperationKind } from '../../../contracts/ipc/generated/L21-backup-governance.ts';
import type { BackupOperationGuard } from '../../plugins/backup/api.ts';
import { OperationBusyError } from '../../plugins/backup/src/operation-errors.ts';

export class MobileOperations {
  private active: BackupOperationGuard | null = null;
  private readonly waiters = new Set<() => void>();

  tryAcquire(kind: DataGovernanceOperationKind): BackupOperationGuard {
    if (this.active) throw new OperationBusyError('已有备份、恢复或同步任务正在运行');
    const id = globalThis.crypto.randomUUID();
    const guard: BackupOperationGuard = {
      snapshot: { operation_id: id, kind, started_at: new Date().toISOString(), process_id: 0 },
      operationId: () => id,
      release: () => {
        if (this.active !== guard) return;
        this.active = null;
        this.waiters.values().next().value?.();
      },
    };
    this.active = guard;
    return guard;
  }

  async acquireWithTimeout(kind: DataGovernanceOperationKind, timeoutMs: number): Promise<BackupOperationGuard | 'timeout'> {
    if (!this.active) return this.tryAcquire(kind);
    return new Promise(resolve => {
      const grant = () => {
        clearTimeout(timer);
        this.waiters.delete(grant);
        resolve(this.tryAcquire(kind));
      };
      const timer = setTimeout(() => { this.waiters.delete(grant); resolve('timeout'); }, timeoutMs);
      this.waiters.add(grant);
    });
  }
}
// Each mobile worker owns its SQLite connections and its operation permit.
export const mobileOperations = new MobileOperations();

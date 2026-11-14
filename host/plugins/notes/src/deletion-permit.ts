// D2: the single DeletePropagation permit is owned by L21. Rust
// `cmd/notes.rs:1469-1472` uses `DataGovernanceOperationGuard::try_acquire`
// (no queueing), acquires before any purge/journal work, and releases on every
// exit path. The formal main API is
// `governance.tryAcquireOperationGuard('delete_propagation')`; L21 publishes
// structured busy/lock-IO failures as `OperationGuardError` (a `CommandError`
// whose value is the Rust-shaped AppError), so this adapter never parses error
// messages and never substitutes a lane-local lock. A missing provider fails
// with Configuration before any note/asset side effect.
import type { Context } from '@deepseek-ai/cordis';
import { CommandError } from '../../../kernel/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import type {
  BackupOperationGuard, DataGovernanceOperationKind,
} from '../../backup/api.ts';

export interface DeletePropagationProvider {
  tryAcquireOperationGuard(kind: DataGovernanceOperationKind): BackupOperationGuard;
}

export const DELETE_PROPAGATION_MISSING =
  '删除操作需要 L21 共享数据治理许可（governance.tryAcquireOperationGuard("delete_propagation")），当前未装配';

/** Acquire the shared permit or fail before any note/asset side effect. */
export function acquireDeletePropagation(ctx: Context): BackupOperationGuard {
  const governance = ctx.get('governance') as unknown as Partial<DeletePropagationProvider> | undefined;
  if (typeof governance?.tryAcquireOperationGuard !== 'function') {
    throw new CommandError(AppError.configuration(DELETE_PROPAGATION_MISSING));
  }
  return governance.tryAcquireOperationGuard('delete_propagation');
}

/** Rust `let _operation = ...::try_acquire(..)?;` scope. */
export function withDeletePropagation<T>(ctx: Context, work: () => T): T {
  const guard = acquireDeletePropagation(ctx);
  try {
    return work();
  } finally {
    guard.release();
  }
}

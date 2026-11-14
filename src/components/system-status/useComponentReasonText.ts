import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { parseComponentReason, type ParsedComponentReason } from './componentReason';

export type ComponentReasonKey =
  | 'join'
  | 'dependency_blocked'
  | 'dependency_restore_failed'
  | 'migration_failed'
  | 'migration_failed_only'
  | 'restored'
  | 'restored_snapshot'
  | 'removed'
  | 'kept'
  | 'kept_no_older'
  | 'kept_older'
  | 'restore_failed'
  | 'remains_blocked'
  | 'schema_aggregation'
  | 'schema_version'
  | 'migration_history'
  | 'recovered_old_schema'
  | 'unsafe_state'
  | 'chat_v2_init'
  | 'llm_usage_init'
  | 'audit_init';

export type ComponentReasonTranslate = (key: ComponentReasonKey, values?: Record<string, string>) => string;

/** en-US 文案与后端原句逐字相同；底层错误、路径、快照名原样嵌入。 */
export function formatComponentReason(parsed: ParsedComponentReason, tr: ComponentReasonTranslate): string {
  const join = (first: string, second: string) => tr('join', { first, second });
  switch (parsed.kind) {
    case 'dependency_blocked':
    case 'dependency_restore_failed':
      return tr(parsed.kind, { dependency: parsed.dependency });
    case 'remains_blocked':
      return tr('remains_blocked', {
        database: parsed.database,
        migrationError: parsed.migrationError,
        restoreError: parsed.restoreError,
      });
    case 'read_failed':
    case 'startup':
      return tr(parsed.step, { error: parsed.error });
    case 'unknown':
      return parsed.text;
    case 'migration_failed': {
      const { database, error, recovery } = parsed;
      if (recovery === null) return tr('migration_failed_only', { database, error });
      const failed = tr('migration_failed', { database, error });
      switch (recovery.kind) {
        case 'restored':
          return join(failed, recovery.snapshot === null ? tr('restored') : tr('restored_snapshot', { snapshot: recovery.snapshot }));
        case 'removed':
          return join(failed, tr('removed', { snapshot: recovery.snapshot }));
        case 'kept':
          return join(
            join(failed, tr('kept', { path: recovery.path })),
            recovery.olderSnapshot === null ? tr('kept_no_older') : tr('kept_older', { snapshot: recovery.olderSnapshot }),
          );
        case 'restore_failed':
          return join(failed, tr('restore_failed', { error: recovery.error }));
      }
    }
  }
}

/** 启动组件健康 `reason` 的界面文本；空原因返回 null，由调用方显示各自的兜底文案。 */
// RUST-FIX(RF-W09-recovery-reason-localized): Rust 版界面原样显示协调器的英文原因，中文界面里整句是英文
export function useComponentReasonText(): (reason: string | null | undefined) => string | null {
  const { t } = useTranslation(['data']);
  return useCallback(
    (reason) =>
      reason
        ? formatComponentReason(parseComponentReason(reason), (key, values) => t(`data:recovery.component_reason.${key}`, values))
        : null,
    [t],
  );
}
